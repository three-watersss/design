import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Config } from "./config.ts";
import type { Task, Attempt } from "./store.ts";
const exec = promisify(execFile);
export type ErrorKind =
  | "rate"
  | "quota"
  | "auth"
  | "proxy"
  | "timeout"
  | "interrupted"
  | "invalid"
  | "cli";
export class RunError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}
export function classify(text: string): ErrorKind {
  if (
    /usage limit|quota|insufficient_quota|额度|usage_limit_reached/i.test(text)
  )
    return "quota";
  if (
    /401|unauthorized|not logged|login required|authentication|登录.*失效/i.test(
      text,
    )
  )
    return "auth";
  if (/429|rate.?limit|too many|concurrency|并发|限流/i.test(text))
    return "rate";
  if (/proxy|ECONNREFUSED|connect.*failed|ENETUNREACH/i.test(text))
    return "proxy";
  if (/timeout|timed out/i.test(text)) return "timeout";
  return "cli";
}
const messages: Record<ErrorKind, string> = {
  rate: "账号请求受限，已暂停派发并等待重试",
  quota: "账号额度不足，请检查 Codex 额度后恢复队列",
  auth: "ChatGPT 登录已失效，请在终端执行 codex login 后恢复队列",
  proxy: "无法连接配置的代理，请检查代理后恢复队列",
  timeout: "生成超时，已终止本次执行",
  interrupted: "执行中断，将恢复对应阶段",
  invalid: "生成结果不完整或不符合格式，请重试",
  cli: "Codex 执行失败，请检查登录、模型权限及网络后重试",
};
export function errorText(kind: ErrorKind) {
  return messages[kind];
}
export function attemptDir(c: Config, id: string) {
  if (!/^[\da-f-]{36}$/i.test(id)) throw Error("Invalid attempt id");
  return path.join(c.dataDir, "attempts", id);
}
export function atomicJSON(file: string, data: unknown) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(file + ".tmp", file);
}
export interface ValidResult {
  images?: { path: string; width: number; height: number; sha256: string }[];
  title?: string;
  body?: string;
  warning?: string;
}
export async function validateResult(
  c: Config,
  a: Attempt,
): Promise<ValidResult> {
  const dir = attemptDir(c, a.id);
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  } catch {
    throw new RunError("invalid", "缺少有效结果 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new RunError("invalid", "结果 JSON 必须是对象");
  if (a.stage === "copy") {
    if (
      typeof raw.title !== "string" ||
      typeof raw.body !== "string" ||
      !raw.title.trim() ||
      !raw.body.trim()
    )
      throw new RunError("invalid", "文案格式不正确");
    return { title: raw.title, body: raw.body };
  }
  if (!Array.isArray(raw.images) || !raw.images.length)
    throw new RunError("invalid", "未生成图片：结果必须包含非空图片清单");
  const seen = new Set<string>();
  const hashes = new Set<string>();
  const images: NonNullable<ValidResult["images"]> = [];
  for (const filename of raw.images) {
    if (typeof filename !== "string")
      throw new RunError("invalid", "图片路径不正确");
    const full = path.resolve(dir, filename),
      imageRoot = path.join(dir, "images") + path.sep;
    if (
      !full.startsWith(imageRoot) ||
      !fs.existsSync(full) ||
      !fs
        .realpathSync(full)
        .startsWith(fs.realpathSync(path.join(dir, "images")) + path.sep) ||
      seen.has(full)
    )
      throw new RunError("invalid", "图片路径无效或重复");
    seen.add(full);
    try {
      const meta = await sharp(full, {
        limitInputPixels: 100_000_000,
      }).metadata();
      if (
        !meta.width ||
        !meta.height ||
        !["png", "jpeg", "webp"].includes(meta.format ?? "")
      )
        throw Error("format");
      await sharp(full).stats();
      const sha256 = createHash("sha256")
        .update(fs.readFileSync(full))
        .digest("hex");
      if (hashes.has(sha256)) throw Error("duplicate");
      hashes.add(sha256);
      images.push({
        path: path.relative(c.dataDir, full),
        width: meta.width,
        height: meta.height,
        sha256,
      });
    } catch {
      throw new RunError("invalid", "图片无法解码或重复");
    }
  }
  const warning = images.some((im, n) =>
    n === 0
      ? im.width !== 1242 || im.height !== 1656
      : im.width * 9 !== im.height * 16,
  )
    ? "原始图片尺寸与模板不完全一致，已保留原图，未缩放或裁切。"
    : undefined;
  return { images, warning };
}
export async function preflight(c: Config) {
  const checks: { name: string; ok: boolean; message: string }[] = [];
  try {
    const { stdout, stderr } = await exec(c.codex, ["login", "status"], {
      timeout: 15000,
    });
    const s = stdout + stderr;
    checks.push({
      name: "ChatGPT 登录",
      ok: /ChatGPT/i.test(s),
      message: /ChatGPT/i.test(s)
        ? "订阅登录已就绪"
        : "请执行 codex login，以 ChatGPT 账号登录",
    });
  } catch {
    checks.push({
      name: "Codex CLI",
      ok: false,
      message: "未找到 Codex CLI 或未登录。安装后执行 codex login",
    });
  }
  try {
    await exec(
      "curl",
      [
        "--silent",
        "--show-error",
        "--max-time",
        "12",
        "--proxy",
        c.proxy,
        "--noproxy",
        "",
        "-o",
        "/dev/null",
        "https://chatgpt.com/",
      ],
      { timeout: 15000 },
    );
    checks.push({ name: "网络代理", ok: true, message: new URL(c.proxy).host });
  } catch {
    checks.push({
      name: "网络代理",
      ok: false,
      message: "无法通过代理连接 ChatGPT，请检查 config.toml 和代理软件",
    });
  }
  for (const [stage, label] of [
    ["images", "图片提示词"],
    ["copy", "文案提示词"],
  ]) {
    try {
      const s = fs.readFileSync(
        path.join(c.root, "prompts", stage + ".md"),
        "utf8",
      );
      if (!s.includes("{{topic}}")) throw Error();
      checks.push({ name: label, ok: true, message: "文件可读取" });
    } catch {
      checks.push({
        name: label,
        ok: false,
        message: "文件缺失或缺少 {{topic}} 占位符",
      });
    }
  }
  try {
    fs.accessSync(c.dataDir, fs.constants.W_OK);
    checks.push({ name: "本地存储", ok: true, message: "可读写" });
  } catch {
    checks.push({ name: "本地存储", ok: false, message: "数据目录不可写" });
  }
  return checks;
}
export interface RunnerContext {
  task: Task;
  attempt: Attempt;
  images: string[];
  ownerFile: string;
  nonce: string;
  onEvent: (event: {
    pid?: number;
    thread?: string;
    progress?: string;
  }) => void;
}
export type Runner = (context: RunnerContext) => Promise<void>;
export function createRunner(c: Config): Runner {
  return async (context) => {
    const { task, attempt: a } = context,
      dir = attemptDir(c, a.id);
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    const schema =
      a.stage === "images"
        ? {
            type: "object",
            properties: {
              images: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["images"],
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "body"],
            additionalProperties: false,
          };
    atomicJSON(path.join(dir, "schema.json"), schema);
    const instructions =
      a.stage === "images"
        ? `使用 imagegen 技能与 ChatGPT 订阅的内置 image_gen 工具，按用户提示词生成一组独立原始图片，张数由提示词决定；未指定张数时根据内容安排，不套用固定张数。逐张顺序生成，不使用子代理或并行调用，不调用 API Key 接口，不使用 HTML/SVG/脚本绘图代替生图，不后期修图。原始模板仅作为内容要求。保持整套视觉一致。将每张原始图片复制到当前目录 images/，按 01-cover、02-detail 等顺序命名。最终只输出符合 schema 的 JSON，images 按顺序列出相对路径。只有全部图片存在才可报告成功；工具不可用则如实失败。`
        : `结合附带的 ${context.images.length} 张实际图片按用户模板写小红书文案。只输出 schema 指定的标题和正文，长度要求遵循用户提示词，不套用固定字数限制。表情分段，不写具体价格。图中的虚构品牌与数据不可描述成真实产品推荐。不要修改图片，不联网，不执行其他任务。`;
    const prompt = `这是本地素材生成任务，仅允许完成当前阶段。不使用任何 API Key，不读取或修改任务目录外的无关文件。账号：${JSON.stringify(task.account)}；主题：${JSON.stringify(task.topic)}。\n${instructions}\n\n以下为用户提示词文件的实际内容：\n${a.prompt}`;
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--disable",
      "multi_agent",
      "-m",
      c.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(c.effort)}`,
      "-c",
      'model_provider="openai"',
      "-c",
      'forced_login_method="chatgpt"',
      "-s",
      a.stage === "images" ? "workspace-write" : "read-only",
      "-C",
      dir,
      "-o",
      path.join(dir, a.stage === "images" ? "response.txt" : "result.json"),
    ];
    if (a.stage === "copy")
      args.push("--output-schema", path.join(dir, "schema.json"));
    for (const img of context.images) args.push("-i", img);
    args.push("-");
    atomicJSON(path.join(dir, "request.json"), {
      bin: c.codex,
      args,
      prompt:
        prompt +
        (a.stage === "images"
          ? '\n完成后必须将图片清单写入当前目录 result.json，格式为 {"images":["images/01-cover.png", ...]}，恰好包含全部独立图片的相对路径。'
          : ""),
      proxy: c.proxy,
      timeoutMs: c.timeoutMs,
      parent: process.pid,
      ownerFile: context.ownerFile,
      nonce: context.nonce,
    });
    await new Promise<void>((resolve, reject) => {
      const worker = spawn(
        process.execPath,
        [path.join(c.root, "scripts", "cli-worker.mjs"), dir],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      );
      context.onEvent({ pid: worker.pid });
      let buffer = "",
        lastError = "";
      worker.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 4_000_000) buffer = buffer.slice(-2_000_000);
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const e = JSON.parse(line);
            if (
              e.type === "thread.started" &&
              /^[a-f\d-]{36}$/i.test(e.thread_id)
            )
              context.onEvent({ thread: e.thread_id });
            if (e.type === "error") lastError = String(e.message ?? "");
            if (e.type === "turn.failed")
              lastError = String(e.error?.message ?? "");
            if (e.type === "turn.started" || e.type === "item.started")
              context.onEvent({
                progress:
                  a.stage === "images"
                    ? "正在生成图片并保存原图"
                    : "正在阅读图片并撰写文案",
              });
            if (e.type === "error")
              context.onEvent({
                progress: "连接出现异常，CLI 正在处理；超过阶段时限将自动停止",
              });
          } catch {}
        }
      });
      worker.on("error", () => reject(new RunError("cli", messages.cli)));
      worker.on("close", () => {
        let receipt: any;
        try {
          receipt = JSON.parse(
            fs.readFileSync(path.join(dir, "receipt.json"), "utf8"),
          );
        } catch {
          return reject(new RunError("interrupted", messages.interrupted));
        }
        if (receipt.exitCode === 0) return resolve();
        const kind =
          receipt.kind === "timeout"
            ? "timeout"
            : receipt.kind === "interrupted"
              ? "interrupted"
              : classify(lastError + " " + receipt.message);
        reject(new RunError(kind, messages[kind]));
      });
    });
  };
}
export async function stopWorker(c: Config, a: Attempt) {
  const dir = attemptDir(c, a.id);
  let pid = a.pid;
  try {
    pid = JSON.parse(
      fs.readFileSync(path.join(dir, "worker.json"), "utf8"),
    ).pid;
  } catch {}
  if (!pid) return;
  const active = () => {
    try {
      const command = execFileSync(
        "ps",
        ["-p", String(pid), "-o", "command="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return command.includes("cli-worker.mjs") && command.includes(dir);
    } catch {
      return false;
    }
  };
  if (!active()) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let n = 0; n < 100 && active(); n++)
    await new Promise((r) => setTimeout(r, 100));
  if (active()) throw Error("上次生成进程尚未退出，暂不恢复，请稍后重启");
}
export function clearCache(thread: string | null) {
  if (!thread || !/^[a-f\d-]{36}$/i.test(thread)) return;
  const root = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
      "generated_images",
    ),
    dir = path.join(root, thread);
  if (
    fs.existsSync(dir) &&
    fs.lstatSync(dir).isDirectory() &&
    !fs.lstatSync(dir).isSymbolicLink()
  )
    fs.rmSync(dir, { recursive: true, force: true });
}
