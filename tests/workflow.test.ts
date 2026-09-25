import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { Store, type Attempt } from "../server/store.ts";
import { Service, Conflict } from "../server/service.ts";
import {
  attemptDir,
  atomicJSON,
  validateResult,
  RunError,
  classify,
  createRunner,
  type Runner,
  type RunnerContext,
} from "../server/runner.ts";
import { previewImport, commitImport } from "../server/importer.ts";
import type { Config } from "../server/config.ts";
const good = async () => [{ name: "test", ok: true, message: "ok" }];
function setup(runner?: Runner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "material-studio-test-"));
  fs.mkdirSync(path.join(root, "prompts"));
  fs.writeFileSync(
    path.join(root, "prompts/images.md"),
    "image {{account}} {{topic}}",
  );
  fs.writeFileSync(path.join(root, "prompts/copy.md"), "copy {{topic}}");
  const c: Config = {
    root,
    dataDir: path.join(root, "data"),
    port: 4317,
    model: "gpt-5.6-sol",
    effort: "high",
    concurrency: 3,
    timeoutMs: 10000,
    proxy: "http://127.0.0.1:7897",
    codex: "codex",
  };
  fs.mkdirSync(c.dataDir);
  const store = new Store(path.join(c.dataDir, "db.sqlite"));
  const produce = async (ctx: RunnerContext) => writeResult(c, ctx.attempt);
  const service = new Service(
    c,
    store,
    runner ?? produce,
    path.join(root, "owner.json"),
    "test",
    good,
  );
  service.checks = [{ name: "test", ok: true, message: "ok" }];
  service.checksAt = Date.now();
  const close = async () => {
    await service.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, c, store, service, close };
}
async function writeResult(c: Config, a: Attempt) {
  const dir = attemptDir(c, a.id);
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  if (a.stage === "copy")
    atomicJSON(path.join(dir, "result.json"), {
      title: "工业机器人方案设计",
      body: "清晰呈现选型逻辑与视觉设计。".repeat(36),
    });
  else {
    const images = [];
    for (let n = 0; n < 6; n++) {
      const file = `images/${n}.png`;
      await sharp({
        create: {
          width: 24,
          height: 24,
          channels: 3,
          background: { r: 30 * n, g: 80, b: 150 },
        },
      })
        .png()
        .toFile(path.join(dir, file));
      images.push(file);
    }
    atomicJSON(path.join(dir, "result.json"), { images });
  }
  atomicJSON(path.join(dir, "receipt.json"), { exitCode: 0 });
}
async function idle(s: Service) {
  await Promise.all([...s.active.values()]);
}
function pendingAttempt(
  x: ReturnType<typeof setup>,
  stage: "images" | "copy" = "images",
) {
  const id = x.store.add("momo", "工业机器人选型"),
    aid = randomUUID();
  x.store.db
    .prepare(
      "INSERT INTO attempts(id,task_id,stage,status,prompt,started_at) VALUES(?,?,?,?,?,?)",
    )
    .run(aid, id, stage, "running", "frozen original", Date.now());
  x.store.update(id, {
    stage,
    state: stage === "images" ? "running_images" : "running_copy",
    attempt_id: aid,
  });
  return { id, a: x.store.attempt(aid)! };
}
test("XLSX checks headers, empty values, duplicates and idempotent commit", async () => {
  const x = setup();
  try {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("选题");
    sheet.addRows([
      ["账号名", "主题"],
      ["momo", "A"],
      ["momo", "A"],
      ["", "B"],
      ["momo", "C"],
    ]);
    const p = await previewImport(
      x.store,
      Buffer.from(await book.xlsx.writeBuffer()),
    );
    assert.equal(p.rows.length, 4);
    assert.equal(p.rows[1].duplicate, true);
    assert.ok(p.rows[2].error);
    const ids = commitImport(x.store, p.id, false);
    assert.equal(ids.length, 2);
    assert.deepEqual(commitImport(x.store, p.id, true), ids);
    const p2 = await previewImport(
      x.store,
      Buffer.from(await book.xlsx.writeBuffer()),
    );
    assert.equal(commitImport(x.store, p2.id, true).length, 3);
  } finally {
    await x.close();
  }
});
test("missing column rejects import", async () => {
  const x = setup();
  try {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("x").addRows([
      ["账号", "主题"],
      ["momo", "x"],
    ]);
    const b = Buffer.from(await book.xlsx.writeBuffer());
    await assert.rejects(() => previewImport(x.store, b), /两列/);
  } finally {
    await x.close();
  }
});
test("global concurrency is 3; review stages release slots", async () => {
  const x = setup();
  let running = 0,
    peak = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  x.service.runner = async (ctx) => {
    running++;
    peak = Math.max(peak, running);
    await gate;
    await writeResult(x.c, ctx.attempt);
    running--;
  };
  try {
    for (let n = 0; n < 5; n++) x.store.add("momo", "topic" + n);
    await x.service.tick();
    await x.service.tick();
    assert.equal(x.service.active.size, 3);
    assert.equal(
      x.store.tasks().filter((t) => t.state === "queued_images").length,
      2,
    );
    release();
    await idle(x.service);
    assert.equal(peak, 3);
    assert.equal(
      x.store.tasks().filter((t) => t.state === "review_images").length,
      3,
    );
    await x.service.tick();
    await idle(x.service);
    assert.equal(
      x.store.tasks().filter((t) => t.state === "review_images").length,
      5,
    );
  } finally {
    release();
    await x.close();
  }
});
test("approval, copy input, deletion, latest prompt, publish picking and duplicate clicks", async () => {
  const x = setup();
  try {
    const id = x.store.add("momo", "topic");
    await x.service.tick();
    await idle(x.service);
    let t = x.store.task(id)!;
    assert.equal(t.state, "review_images");
    assert.equal(x.store.assets(id).length, 6);
    const old = t.image_attempt!;
    fs.writeFileSync(path.join(x.root, "prompts/images.md"), "NEW {{topic}}");
    x.store.set("paused", true);
    await x.service.regenerate(id, t.version);
    assert.equal(fs.existsSync(attemptDir(x.c, old)), false);
    assert.equal(x.store.assets(id).length, 0);
    await assert.rejects(() => x.service.regenerate(id, t.version), Conflict);
    x.store.set("paused", false);
    await x.service.tick();
    await idle(x.service);
    t = x.store.task(id)!;
    assert.equal(x.store.attempt(t.attempt_id!)!.prompt, "NEW topic");
    const imageFiles = x.store
      .assets(id)
      .map((a) => path.join(x.c.dataDir, a.path));
    x.service.runner = async (ctx) => {
      assert.deepEqual(ctx.images, imageFiles);
      await writeResult(x.c, ctx.attempt);
    };
    x.service.approve(id, t.version);
    assert.throws(() => x.service.approve(id, t.version), Conflict);
    await idle(x.service);
    t = x.store.task(id)!;
    assert.equal(t.state, "review_copy");
    const copyAttempt = t.copy_attempt!;
    fs.writeFileSync(path.join(x.root, "prompts/copy.md"), "UPDATED {{topic}}");
    x.store.set("paused", true);
    await x.service.regenerate(id, t.version);
    assert.equal(fs.existsSync(attemptDir(x.c, copyAttempt)), false);
    assert.ok(imageFiles.every((f) => fs.existsSync(f)));
    assert.equal(x.store.task(id)!.body, null);
    x.store.set("paused", false);
    await x.service.tick();
    await idle(x.service);
    t = x.store.task(id)!;
    assert.equal(x.store.attempt(t.attempt_id!)!.prompt, "UPDATED topic");
    x.service.approve(id, t.version);
    t = x.store.task(id)!;
    assert.equal(t.state, "ready");
    assert.equal(x.service.pick("momo", [])?.id, id);
    assert.equal(x.service.pick("momo", [id]), null);
    assert.equal(x.service.pick("other", []), null);
    x.service.publish(id, t.version);
    x.service.publish(id, t.version);
    assert.equal(x.service.pick("", []), null);
    assert.ok(x.store.task(id)!.published_at);
  } finally {
    await x.close();
  }
});
test("interrupted image group is deleted and original snapshot retained", async () => {
  const x = setup();
  try {
    const { id, a } = pendingAttempt(x);
    const dir = attemptDir(x.c, a.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "partial.png"), "partial");
    fs.writeFileSync(
      path.join(x.root, "prompts/images.md"),
      "LATEST {{topic}}",
    );
    await x.service.recover();
    const t = x.store.task(id)!;
    assert.equal(t.state, "queued_images");
    assert.equal(t.retry_prompt, "frozen original");
    assert.ok(!fs.existsSync(dir));
    await x.service.tick();
    await idle(x.service);
    assert.equal(
      x.store.attempt(x.store.task(id)!.attempt_id!)!.prompt,
      "frozen original",
    );
  } finally {
    await x.close();
  }
});
test("finished files before DB commit recover to review without another generation", async () => {
  const x = setup();
  try {
    const { id, a } = pendingAttempt(x);
    await writeResult(x.c, a);
    await x.service.recover();
    assert.equal(x.store.task(id)!.state, "review_images");
    assert.equal(x.store.assets(id).length, 6);
    await x.service.recover();
    assert.equal(x.store.task(id)!.state, "review_images");
  } finally {
    await x.close();
  }
});
test("interrupted copy keeps approved images", async () => {
  const x = setup();
  try {
    const id = x.store.add("momo", "x");
    await x.service.tick();
    await idle(x.service);
    const images = x.store.assets(id);
    const t = x.store.task(id)!;
    x.store.set("paused", true);
    x.service.approve(id, t.version);
    const aid = randomUUID();
    x.store.db
      .prepare(
        "INSERT INTO attempts(id,task_id,stage,status,prompt,started_at) VALUES(?,?,?,?,?,?)",
      )
      .run(aid, id, "copy", "running", "copy original", Date.now());
    x.store.update(id, { state: "running_copy", attempt_id: aid });
    await x.service.recover();
    assert.equal(x.store.task(id)!.state, "queued_copy");
    assert.deepEqual(x.store.assets(id), images);
    assert.ok(
      images.every((a) => fs.existsSync(path.join(x.c.dataDir, a.path))),
    );
  } finally {
    await x.close();
  }
});
test("interrupted deletion resumes safely", async () => {
  const x = setup();
  try {
    const { id, a } = pendingAttempt(x);
    await writeResult(x.c, a);
    x.store.update(id, { state: "cleaning" });
    x.store.set("cleanup:" + id, { action: "regenerate", stage: "images" });
    await x.service.recover();
    assert.equal(x.store.task(id)!.state, "queued_images");
    assert.ok(!fs.existsSync(attemptDir(x.c, a.id)));
    assert.equal(x.store.attempt(a.id)!.prompt, null);
  } finally {
    await x.close();
  }
});
test("rate errors cool down and stop after three consecutive failures", async () => {
  const x = setup(async () => {
    throw new RunError("rate", "rate");
  });
  try {
    const id = x.store.add("momo", "x");
    for (let i = 1; i <= 3; i++) {
      x.store.set("cooldown", 0);
      x.store.update(id, { next_at: 0 });
      await x.service.tick();
      await idle(x.service);
      assert.equal(x.store.task(id)!.failures, i);
      if (i < 3) {
        assert.equal(x.store.task(id)!.state, "queued_images");
        assert.ok(x.store.get("cooldown", 0) > Date.now());
      }
    }
    assert.equal(x.store.task(id)!.state, "failed");
  } finally {
    await x.close();
  }
});
test("quota and auth block globally; malformed output does not endlessly retry", async () => {
  for (const kind of ["quota", "auth", "invalid"] as const) {
    const x = setup(async () => {
      throw new RunError(kind, kind);
    });
    try {
      const id = x.store.add("a", "b");
      await x.service.tick();
      await idle(x.service);
      assert.equal(
        x.store.task(id)!.state,
        kind === "invalid" ? "failed" : "blocked",
      );
      if (kind !== "invalid") assert.ok(x.store.get("blocked", null));
      await x.service.tick();
      assert.equal(x.service.active.size, 0);
    } finally {
      await x.close();
    }
  }
});
test("proxy preflight and manual pause prevent dispatch", async () => {
  const x = setup();
  try {
    x.store.add("a", "b");
    x.service.probe = async () => [
      { name: "proxy", ok: false, message: "offline" },
    ];
    await x.service.check();
    await x.service.tick();
    assert.equal(x.service.active.size, 0);
    await assert.rejects(() => x.service.pause(false));
    x.service.probe = good;
    await x.service.check();
    await x.service.pause(true);
    await x.service.tick();
    assert.equal(x.service.active.size, 0);
  } finally {
    await x.close();
  }
});
test("empty, duplicate, path escaping and broken images fail validation", async () => {
  const x = setup();
  try {
    const { a } = pendingAttempt(x);
    await writeResult(x.c, a);
    const file = path.join(attemptDir(x.c, a.id), "result.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    atomicJSON(file, { images: [] });
    await assert.rejects(() => validateResult(x.c, a), RunError);
    atomicJSON(file, { images: Array(6).fill(raw.images[0]) });
    await assert.rejects(() => validateResult(x.c, a), RunError);
    atomicJSON(file, { images: ["../../bad", ...raw.images.slice(1)] });
    await assert.rejects(() => validateResult(x.c, a), RunError);
    atomicJSON(file, raw);
    fs.writeFileSync(
      path.join(attemptDir(x.c, a.id), raw.images[0]),
      "invalid",
    );
    await assert.rejects(() => validateResult(x.c, a), RunError);
  } finally {
    await x.close();
  }
});
test("classifies actionable errors without retaining generated content", () => {
  assert.equal(classify("429 Too many requests"), "rate");
  assert.equal(classify("usage_limit_reached"), "quota");
  assert.equal(classify("401 Unauthorized"), "auth");
  assert.equal(classify("connect ECONNREFUSED proxy"), "proxy");
  assert.equal(classify("request timed out"), "timeout");
});

test("cleanup failure blocks dispatch and can resume after storage is repaired", async () => {
  const x = setup(async () => {
    throw new RunError("invalid", "bad");
  });
  const cleanup = x.service.finishCleanup.bind(x.service);
  try {
    const id = x.store.add("momo", "cleanup");
    x.service.finishCleanup = async () => {
      throw Error("disk unavailable");
    };
    await x.service.tick();
    await idle(x.service);
    assert.equal(x.store.task(id)!.state, "cleaning");
    assert.ok(x.store.get("blocked", null));
    x.service.finishCleanup = cleanup;
    await x.service.pause(false);
    assert.equal(x.store.task(id)!.state, "failed");
    assert.equal(x.store.get("blocked", null), null);
  } finally {
    await x.close();
  }
});

test("startup recovery failure remains resumable with its scheduler intact", async () => {
  const x = setup();
  const recover = x.service.recover.bind(x.service);
  try {
    x.service.recover = async () => {
      throw Error("locked");
    };
    await x.service.start();
    assert.ok(x.service.timer);
    assert.equal(x.service.recoveryPending, true);
    assert.ok(x.store.get("blocked", null));
    x.service.recover = recover;
    await x.service.pause(false);
    assert.equal(x.service.recoveryPending, false);
    assert.equal(x.store.get("blocked", null), null);
  } finally {
    await x.close();
  }
});

async function readyMaterial(
  x: ReturnType<typeof setup>,
  topic = "待删除素材",
) {
  const id = x.store.add("momo", topic);
  await x.service.tick();
  await idle(x.service);
  x.service.approve(id, x.store.task(id)!.version);
  await idle(x.service);
  x.service.approve(id, x.store.task(id)!.version);
  return x.store.task(id)!;
}

test("material deletion removes both stages, SQLite associations and import cache, preserving other material", async () => {
  const x = setup();
  try {
    const t = await readyMaterial(x),
      other = await readyMaterial(x, "保留素材");
    const ids = (
      x.store.db
        .prepare("SELECT id FROM attempts WHERE task_id=?")
        .all(t.id) as { id: string }[]
    ).map((a) => a.id);
    x.store.db
      .prepare("INSERT INTO imports VALUES(?,?,?,?)")
      .run(
        "import-cache",
        JSON.stringify([{ account: t.account, topic: t.topic }]),
        Date.now(),
        JSON.stringify([t.id]),
      );
    await assert.rejects(
      () => x.service.deleteMaterial(t.id, t.version - 1),
      Conflict,
    );
    await x.service.deleteMaterial(t.id, t.version);
    assert.equal(x.store.task(t.id), undefined);
    assert.equal(x.store.assets(t.id).length, 0);
    assert.equal(
      x.store.db
        .prepare("SELECT count(*) AS n FROM attempts WHERE task_id=?")
        .get(t.id)!.n,
      0,
    );
    assert.equal(
      x.store.db.prepare("SELECT count(*) AS n FROM imports").get()!.n,
      0,
    );
    assert.equal(x.store.get("cleanup:" + t.id, null), null);
    assert.ok(ids.every((id) => !fs.existsSync(attemptDir(x.c, id))));
    assert.equal(x.store.task(other.id)!.state, "ready");
    assert.equal(x.service.pick("", [])!.id, other.id);
    await x.service.deleteMaterial(t.id, t.version);
    x.service.publish(other.id, other.version);
    await assert.rejects(
      () => x.service.deleteMaterial(other.id, x.store.task(other.id)!.version),
      Conflict,
    );
    const pending = x.store.add("momo", "未完成");
    await assert.rejects(
      () => x.service.deleteMaterial(pending, x.store.task(pending)!.version),
      Conflict,
    );
  } finally {
    await x.close();
  }
});

test("interrupted material deletion resumes without requeueing generation", async () => {
  const x = setup();
  const finish = x.service.finishCleanup.bind(x.service);
  try {
    const t = await readyMaterial(x),
      images = x.store.assets(t.id);
    x.service.finishCleanup = async () => {
      fs.rmSync(path.join(x.c.dataDir, images[0].path));
      throw Error("interrupted");
    };
    await assert.rejects(
      () => x.service.deleteMaterial(t.id, t.version),
      /删除未完成/,
    );
    assert.equal(x.store.task(t.id)!.state, "cleaning");
    assert.equal(x.store.get<any>("cleanup:" + t.id, null).action, "delete");
    x.service.finishCleanup = finish;
    await x.service.recover();
    assert.equal(x.store.task(t.id), undefined);
    assert.equal(x.store.tasks().length, 0);
    assert.ok(
      images.every((a) => !fs.existsSync(path.join(x.c.dataDir, a.path))),
    );
    await x.service.recover();
    assert.equal(x.service.active.size, 0);
  } finally {
    await x.close();
  }
});

test("image validation accepts variable positive counts and copy receives every actual image", async () => {
  const x = setup();
  try {
    const { id, a } = pendingAttempt(x);
    await writeResult(x.c, a);
    const file = path.join(attemptDir(x.c, a.id), "result.json");
    const all = JSON.parse(fs.readFileSync(file, "utf8")).images;
    for (const n of [1, 3, 5]) {
      atomicJSON(file, { images: all.slice(0, n) });
      assert.equal((await validateResult(x.c, a)).images!.length, n);
    }
    for (let n = 6; n < 8; n++) {
      const name = `images/${n}.png`;
      await sharp({
        create: {
          width: 24,
          height: 24,
          channels: 3,
          background: { r: 30 * n, g: 80, b: 150 },
        },
      })
        .png()
        .toFile(path.join(attemptDir(x.c, a.id), name));
      all.push(name);
    }
    atomicJSON(file, { images: all });
    await x.service.recover();
    assert.equal(x.store.assets(id).length, 8);
    let supplied = 0;
    x.service.runner = async (ctx) => {
      supplied = ctx.images.length;
      await writeResult(x.c, ctx.attempt);
    };
    x.service.approve(id, x.store.task(id)!.version);
    await idle(x.service);
    assert.equal(supplied, 8);
    assert.equal(x.store.task(id)!.state, "review_copy");
  } finally {
    await x.close();
  }
});

test("CLI image request has no fixed count; copy request names actual attached count", async () => {
  const x = setup();
  try {
    fs.mkdirSync(path.join(x.root, "scripts"));
    fs.writeFileSync(
      path.join(x.root, "scripts/cli-worker.mjs"),
      `import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(path.join(process.argv[2],'receipt.json'),JSON.stringify({exitCode:0}));`,
    );
    const { id, a } = pendingAttempt(x),
      run = createRunner(x.c);
    const ctx = {
      task: x.store.task(id)!,
      attempt: a,
      images: [],
      ownerFile: "unused",
      nonce: "test",
      onEvent: () => {},
    };
    await run(ctx);
    const dir = attemptDir(x.c, a.id),
      schema = JSON.parse(
        fs.readFileSync(path.join(dir, "schema.json"), "utf8"),
      );
    assert.equal(schema.properties.images.minItems, undefined);
    assert.equal(schema.properties.images.maxItems, undefined);
    const request = JSON.parse(
      fs.readFileSync(path.join(dir, "request.json"), "utf8"),
    );
    assert.match(request.prompt, /张数由提示词决定/);
    assert.doesNotMatch(request.prompt, /6 张|六张/);
    await run({
      ...ctx,
      attempt: { ...a, stage: "copy" },
      images: ["one.png", "two.png", "three.png"],
    });
    const copy = JSON.parse(
      fs.readFileSync(path.join(dir, "request.json"), "utf8"),
    );
    assert.match(copy.prompt, /附带的 3 张实际图片/);
    assert.equal(copy.args.filter((arg: string) => arg === "-i").length, 3);
    assert.match(copy.prompt, /长度要求遵循用户提示词/);
    assert.doesNotMatch(copy.prompt, /20字符|400|600|640/);
    const copySchema = JSON.parse(
      fs.readFileSync(path.join(dir, "schema.json"), "utf8"),
    );
    assert.deepEqual(copySchema.properties, {
      title: { type: "string" },
      body: { type: "string" },
    });
    assert.deepEqual(copySchema.required, ["title", "body"]);
    assert.equal(copySchema.additionalProperties, false);
  } finally {
    await x.close();
  }
});

test("copy accepts short and long text while rejecting missing, non-string and empty fields", async () => {
  const x = setup();
  try {
    const { a } = pendingAttempt(x, "copy");
    const dir = attemptDir(x.c, a.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "result.json");
    for (const value of [
      { title: "题", body: "文" },
      { title: "长标题".repeat(50), body: "很长的正文🤖\n".repeat(500) },
    ]) {
      atomicJSON(file, value);
      assert.deepEqual(await validateResult(x.c, a), value);
    }
    for (const value of [
      { body: "正文" },
      { title: "标题" },
      { title: 12, body: "正文" },
      { title: "标题", body: null },
      { title: " \n", body: "正文" },
      { title: "标题", body: "\t " },
    ]) {
      atomicJSON(file, value);
      await assert.rejects(() => validateResult(x.c, a), RunError);
    }
  } finally {
    await x.close();
  }
});
