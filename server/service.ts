import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Store, type Task, type Attempt, type Stage } from "./store.ts";
import { readPrompt, type Config } from "./config.ts";
import {
  attemptDir,
  validateResult,
  RunError,
  errorText,
  clearCache,
  stopWorker,
  preflight,
  type Runner,
  type ValidResult,
} from "./runner.ts";
export class Conflict extends Error {}
export class Service extends EventEmitter {
  active = new Map<string, Promise<void>>();
  closing = false;
  busy = false;
  recoveryPending = false;
  timer?: NodeJS.Timeout;
  checks: Awaited<ReturnType<typeof preflight>> = [];
  checksAt = 0;
  constructor(
    public c: Config,
    public store: Store,
    public runner: Runner,
    public ownerFile: string,
    public nonce: string,
    public probe = () => preflight(c),
  ) {
    super();
  }
  notify() {
    this.emit("change");
  }
  view(t: Task) {
    const { retry_prompt, ...safe } = t;
    const reviewAttempt =
      t.state === "review_images"
        ? t.image_attempt
        : t.state === "review_copy"
          ? t.copy_attempt
          : null;
    return {
      ...safe,
      review_finished_at: reviewAttempt
        ? (this.store.attempt(reviewAttempt)?.finished_at ?? null)
        : null,
      images: this.store.assets(t.id).map((a) => ({
        id: a.id,
        url: `/api/assets/${a.id}`,
        width: a.width,
        height: a.height,
        position: a.position,
      })),
      title: t.title,
      body: t.body,
    };
  }
  snapshot() {
    const tasks = this.store.tasks();
    return {
      tasks: tasks.map((t) => this.view(t)),
      queue: {
        paused: this.store.get("paused", false),
        blocked: this.store.get<string | null>("blocked", null),
        cooldownUntil: this.store.get("cooldown", 0),
        running: this.active.size,
        concurrency: this.c.concurrency,
      },
      checks: this.checks,
      config: {
        model: this.c.model,
        effort: this.c.effort,
        proxyHost: new URL(this.c.proxy).host,
      },
      counts: {
        running: tasks.filter((t) => t.state.startsWith("running")).length,
        queued: tasks.filter((t) => t.state.startsWith("queued")).length,
        review: tasks.filter((t) => t.state.startsWith("review")).length,
        ready: tasks.filter((t) => t.state === "ready").length,
        published: tasks.filter((t) => t.state === "published").length,
      },
    };
  }
  async check() {
    this.checks = await this.probe();
    this.checksAt = Date.now();
    this.notify();
    return this.checks.every((c) => c.ok);
  }
  async recover() {
    const tasks = this.store.tasks();
    for (const t of tasks) {
      if (t.state === "cleaning") {
        await this.finishCleanup(t);
        continue;
      }
      if (!t.state.startsWith("running")) continue;
      const a = t.attempt_id ? this.store.attempt(t.attempt_id) : undefined;
      if (!a) {
        this.store.update(t.id, {
          state: t.stage === "images" ? "queued_images" : "queued_copy",
          error: null,
        });
        continue;
      }
      await stopWorker(this.c, a);
      try {
        const receipt = JSON.parse(
          fs.readFileSync(
            path.join(attemptDir(this.c, a.id), "receipt.json"),
            "utf8",
          ),
        );
        if (receipt.exitCode !== 0) throw Error();
        const result = await validateResult(this.c, a);
        this.complete(t, a, result);
      } catch {
        await this.cleanup(t, "retry", a.prompt);
      }
    }
  }
  async start() {
    try {
      await this.recover();
    } catch {
      this.recoveryPending = true;
      this.store.set(
        "blocked",
        "恢复检查未完成，请检查目录权限及旧进程后恢复队列",
      );
    }
    await this.check();
    this.timer = setInterval(() => void this.tick(), 1000);
    await this.tick();
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of this.store
      .tasks()
      .filter((t) => t.state.startsWith("running"))) {
      const a = t.attempt_id ? this.store.attempt(t.attempt_id) : undefined;
      if (a) await stopWorker(this.c, a);
    }
    await Promise.allSettled(this.active.values());
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.busy = true;
    try {
      if (
        this.store.get("paused", false) ||
        this.store.get("blocked", null) ||
        this.store.get("cooldown", 0) > Date.now()
      )
        return;
      const queued = this.store
        .tasks()
        .filter((t) => t.state.startsWith("queued") && t.next_at <= Date.now())
        .sort(
          (a, b) => a.queued_at - b.queued_at || a.created_at - b.created_at,
        );
      if (!queued.length) return;
      if (Date.now() - this.checksAt > 30000) await this.check();
      if (this.checks.some((c) => !c.ok)) return;
      for (const t of queued) {
        if (this.active.size >= this.c.concurrency || this.closing) break;
        const current = this.store.task(t.id);
        if (!current || !current.state.startsWith("queued")) continue;
        let prompt: string;
        try {
          prompt =
            current.retry_prompt ??
            readPrompt(this.c, current.stage, current.account, current.topic);
        } catch (e) {
          this.store.update(t.id, { state: "failed", error: String(e) });
          this.notify();
          continue;
        }
        const id = randomUUID(),
          now = Date.now();
        this.store.transaction(() => {
          this.store.db
            .prepare(
              "INSERT INTO attempts(id,task_id,stage,status,prompt,started_at) VALUES(?,?,?,?,?,?)",
            )
            .run(id, t.id, current.stage, "running", prompt, now);
          this.store.update(t.id, {
            state:
              current.stage === "images" ? "running_images" : "running_copy",
            attempt_id: id,
            error: null,
            progress: "正在启动生成",
            retry_prompt: null,
          });
        });
        const a = this.store.attempt(id)!,
          task = this.store.task(t.id)!;
        const work = this.execute(task, a)
          .catch(() => {
            this.store.set(
              "blocked",
              "结果清理或存储失败，请检查目录权限和可用空间后恢复队列",
            );
            this.notify();
          })
          .finally(() => {
            this.active.delete(t.id);
            this.notify();
          });
        this.active.set(t.id, work);
        this.notify();
      }
    } catch {
      this.store.set("blocked", "任务调度失败，请检查本地存储后恢复队列");
      this.notify();
    } finally {
      this.busy = false;
    }
  }
  async execute(t: Task, a: Attempt) {
    try {
      await this.runner({
        task: t,
        attempt: a,
        images:
          a.stage === "copy"
            ? this.store
                .assets(t.id)
                .map((x) => path.join(this.c.dataDir, x.path))
            : [],
        ownerFile: this.ownerFile,
        nonce: this.nonce,
        onEvent: (e) => {
          const current = this.store.task(t.id);
          if (
            current?.attempt_id !== a.id ||
            !current.state.startsWith("running")
          )
            return;
          if (e.pid)
            this.store.db
              .prepare("UPDATE attempts SET pid=? WHERE id=?")
              .run(e.pid, a.id);
          if (e.thread)
            this.store.db
              .prepare("UPDATE attempts SET thread_id=? WHERE id=?")
              .run(e.thread, a.id);
          if (e.progress) {
            this.store.update(t.id, { progress: e.progress });
            this.notify();
          }
        },
      });
      if (this.closing) return;
      const result = await validateResult(this.c, a);
      this.complete(t, a, result);
    } catch (error) {
      if (this.closing) return;
      const current = this.store.task(t.id);
      if (current?.attempt_id !== a.id || !current.state.startsWith("running"))
        return;
      const kind = error instanceof RunError ? error.kind : "invalid";
      const failures = current.failures + 1;
      this.store.update(t.id, {
        failures,
        error:
          kind === "invalid" && error instanceof RunError
            ? error.message
            : errorText(kind),
        progress: "",
      });
      this.store.db
        .prepare("UPDATE attempts SET error_kind=? WHERE id=?")
        .run(kind, a.id);
      if (["auth", "quota", "proxy"].includes(kind)) {
        this.store.set("blocked", errorText(kind));
        await this.cleanup(this.store.task(t.id)!, "blocked", a.prompt);
      } else if (
        ["rate", "timeout", "interrupted"].includes(kind) &&
        failures < 3
      ) {
        const delay = [60000, 120000, 240000][Math.min(failures - 1, 2)];
        this.store.update(t.id, { next_at: Date.now() + delay });
        if (kind === "rate") this.store.set("cooldown", Date.now() + delay);
        await this.cleanup(this.store.task(t.id)!, "retry", a.prompt);
      } else {
        if (kind === "rate") this.store.set("cooldown", Date.now() + 240000);
        await this.cleanup(this.store.task(t.id)!, "failed", a.prompt);
      }
      this.notify();
    }
  }
  complete(t: Task, a: Attempt, result: ValidResult) {
    const current = this.store.task(t.id);
    if (current?.attempt_id !== a.id || !current.state.startsWith("running"))
      return;
    this.store.transaction(() => {
      if (a.stage === "images") {
        this.store.db.prepare("DELETE FROM assets WHERE task_id=?").run(t.id);
        result.images!.forEach((im, n) =>
          this.store.db
            .prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)")
            .run(
              randomUUID(),
              t.id,
              a.id,
              n,
              im.path,
              im.width,
              im.height,
              im.sha256,
            ),
        );
        this.store.update(t.id, {
          state: "review_images",
          image_attempt: a.id,
          warning: result.warning ?? null,
          failures: 0,
          error: null,
          progress: "图片已生成，等待审核",
          next_at: 0,
        });
      } else
        this.store.update(t.id, {
          state: "review_copy",
          copy_attempt: a.id,
          title: result.title!,
          body: result.body!,
          failures: 0,
          error: null,
          progress: "文案已生成，等待审核",
          next_at: 0,
        });
      this.store.db
        .prepare("UPDATE attempts SET status='done',finished_at=? WHERE id=?")
        .run(Date.now(), a.id);
    });
    clearCache(this.store.attempt(a.id)!.thread_id);
    // Do not keep verbose agent logs or diagnostic payloads with generated content.
    for (const file of [
      "request.json",
      "receipt.json",
      "schema.json",
      "response.txt",
    ])
      fs.rmSync(path.join(attemptDir(this.c, a.id), file), { force: true });
    this.notify();
  }
  require(id: string, version: number, states: string[]) {
    const t = this.store.task(id);
    if (!t) throw new Conflict("选题不存在");
    if (t.version !== version || !states.includes(t.state))
      throw new Conflict("任务状态已变化，请查看最新状态");
    return t;
  }
  approve(id: string, version: number) {
    const t = this.require(id, version, ["review_images", "review_copy"]);
    this.store.transaction(() => {
      if (t.state === "review_images")
        this.store.update(id, {
          state: "queued_copy",
          stage: "copy",
          retry_prompt: null,
          failures: 0,
          next_at: 0,
          queued_at: Date.now(),
          progress: "等待生成文案",
        });
      else
        this.store.update(id, {
          state: "ready",
          progress: "完整素材已入库",
          error: null,
        });
    });
    this.notify();
    void this.tick();
  }
  async regenerate(id: string, version: number) {
    const t = this.require(id, version, ["review_images", "review_copy"]);
    await this.cleanup(t, "regenerate", null);
    this.notify();
    void this.tick();
  }
  async retry(id: string, version: number) {
    const t = this.require(id, version, ["failed", "blocked"]);
    this.store.update(id, {
      state: t.stage === "images" ? "queued_images" : "queued_copy",
      failures: 0,
      next_at: 0,
      queued_at: Date.now(),
      error: null,
      progress: "已重新排队",
    });
    this.notify();
    void this.tick();
  }
  async deleteMaterial(id: string, version: number) {
    if (!this.store.task(id)) return;
    const t = this.require(id, version, ["ready"]);
    try {
      // Persist deletion intent before touching files so a restart can finish it.
      await this.cleanup(t, "delete", null);
    } catch {
      this.store.set(
        "blocked",
        "素材删除未完成，请检查目录权限和可用空间后恢复队列，或重启继续清理",
      );
      throw Error(
        "素材删除未完成，删除进度已保存；修复存储问题后恢复队列即可继续",
      );
    } finally {
      this.notify();
    }
  }
  async cleanup(t: Task, action: string, prompt: string | null) {
    this.store.transaction(() => {
      this.store.update(t.id, {
        state: "cleaning",
        retry_prompt: prompt,
        progress: action === "delete" ? "正在删除素材" : "正在清理旧结果",
      });
      if (t.attempt_id)
        this.store.db
          .prepare(
            "UPDATE attempts SET status='cleaning',cleanup_action=? WHERE id=?",
          )
          .run(action, t.attempt_id);
      this.store.set("cleanup:" + t.id, {
        action,
        stage: action === "delete" ? "images" : t.stage,
      });
    });
    await this.finishCleanup(this.store.task(t.id)!);
  }
  async finishCleanup(t: Task) {
    const saved = this.store.get<{ action: string; stage: Stage }>(
      "cleanup:" + t.id,
      { action: "retry", stage: t.stage },
    );
    const attempts = this.store.db
      .prepare("SELECT * FROM attempts WHERE task_id=?")
      .all(t.id) as unknown as Attempt[];
    for (const a of attempts.filter(
      (a) => saved.stage === "images" || a.stage === "copy",
    )) {
      await stopWorker(this.c, a);
      clearCache(a.thread_id);
      fs.rmSync(attemptDir(this.c, a.id), { recursive: true, force: true });
    }
    this.store.transaction(() => {
      if (saved.action === "delete") {
        this.store.db.prepare("DELETE FROM assets WHERE task_id=?").run(t.id);
        this.store.db.prepare("DELETE FROM attempts WHERE task_id=?").run(t.id);
        this.store.db
          .prepare("DELETE FROM settings WHERE key=?")
          .run("cleanup:" + t.id);
        // Import previews are temporary caches, not material records. Drop affected
        // caches so they cannot keep references to the removed task or re-create it.
        this.store.db
          .prepare(
            "DELETE FROM imports WHERE EXISTS (SELECT 1 FROM json_each(imports.result) WHERE value=?)",
          )
          .run(t.id);
        this.store.db.prepare("DELETE FROM tasks WHERE id=?").run(t.id);
        return;
      }
      const state =
        saved.action === "failed"
          ? "failed"
          : saved.action === "blocked"
            ? "blocked"
            : saved.stage === "images"
              ? "queued_images"
              : "queued_copy";
      if (saved.stage === "images")
        this.store.db.prepare("DELETE FROM assets WHERE task_id=?").run(t.id);
      this.store.db
        .prepare(
          `UPDATE attempts SET status='deleted',prompt=NULL,pid=NULL,thread_id=NULL WHERE task_id=? ${saved.stage === "copy" ? "AND stage='copy'" : ""}`,
        )
        .run(t.id);
      const patch: Partial<Task> = {
        state,
        attempt_id: null,
        copy_attempt: null,
        title: null,
        body: null,
        queued_at: Date.now(),
        progress: state.startsWith("queued") ? "等待生成" : "",
        ...(saved.stage === "images"
          ? { image_attempt: null, warning: null }
          : {}),
      };
      if (saved.action === "regenerate")
        Object.assign(patch, {
          retry_prompt: null,
          failures: 0,
          next_at: 0,
          error: null,
        });
      this.store.update(t.id, patch);
      this.store.db
        .prepare("DELETE FROM settings WHERE key=?")
        .run("cleanup:" + t.id);
    });
  }
  async pause(paused: boolean) {
    if (!paused) {
      if (!(await this.check()))
        throw Error("启动检查未通过，请修复后恢复队列");
      if (this.recoveryPending) {
        await this.recover();
        this.recoveryPending = false;
      }
      for (const t of this.store.tasks().filter((t) => t.state === "cleaning"))
        await this.finishCleanup(t);
      this.store.set("blocked", null);
      for (const t of this.store.tasks().filter((t) => t.state === "blocked"))
        this.store.update(t.id, {
          state: t.stage === "images" ? "queued_images" : "queued_copy",
          next_at: 0,
          error: null,
          failures: 0,
          queued_at: Date.now(),
        });
    }
    this.store.set("paused", paused);
    this.notify();
    void this.tick();
  }
  pick(account: string, excluded: string[]) {
    const tasks = this.store
      .tasks()
      .filter(
        (t) =>
          t.state === "ready" &&
          (!account || t.account === account) &&
          !excluded.includes(t.id),
      );
    return tasks.length
      ? this.view(tasks[Math.floor(Math.random() * tasks.length)])
      : null;
  }
  publish(id: string, version: number) {
    const existing = this.store.task(id);
    if (existing?.state === "published") return;
    this.require(id, version, ["ready"]);
    this.store.update(id, { state: "published", published_at: Date.now() });
    this.notify();
  }
}
