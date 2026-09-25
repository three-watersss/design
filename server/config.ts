import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
export interface Config {
  root: string;
  dataDir: string;
  port: number;
  model: string;
  effort: string;
  concurrency: number;
  timeoutMs: number;
  codex: string;
  proxy: string;
}
export function loadConfig(root = process.cwd()): Config {
  const raw = parse(
    fs.readFileSync(path.join(root, "config.toml"), "utf8"),
  ) as any;
  const positive = (v: unknown, name: string, max: number) => {
    if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > max)
      throw Error(`config.toml: ${name} 必须为 1–${max} 的整数`);
    return Number(v);
  };
  const proxy = String(raw.network?.proxy ?? "");
  const u = new URL(proxy);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("代理必须使用 http:// 或 https:// 地址");
  const c: Config = {
    root: path.resolve(root),
    dataDir: path.resolve(root, raw.server?.data_dir ?? "data"),
    port: positive(raw.server?.port, "port", 65535),
    model: String(raw.generation?.model ?? ""),
    effort: String(raw.generation?.reasoning_effort ?? ""),
    concurrency: positive(
      raw.generation?.max_concurrency,
      "max_concurrency",
      16,
    ),
    timeoutMs:
      positive(raw.generation?.timeout_minutes, "timeout_minutes", 240) * 60000,
    codex: String(raw.generation?.codex_bin ?? "codex"),
    proxy,
  };
  if (
    !c.model ||
    !["none", "low", "medium", "high", "xhigh", "max"].includes(c.effort)
  )
    throw Error("模型或思考程度配置不正确");
  if (c.dataDir === c.root || c.root.startsWith(c.dataDir + path.sep))
    throw Error("数据目录不能是项目根目录或其上级");
  fs.mkdirSync(c.dataDir, { recursive: true });
  fs.accessSync(c.dataDir, fs.constants.W_OK);
  return c;
}
export function readPrompt(
  c: Config,
  stage: "images" | "copy",
  account: string,
  topic: string,
) {
  const template = fs.readFileSync(
    path.join(c.root, "prompts", stage + ".md"),
    "utf8",
  );
  if (!template.includes("{{topic}}"))
    throw Error("提示词缺少 {{topic}} 占位符");
  return template
    .replaceAll("{{account}}", account)
    .replaceAll("{{topic}}", topic);
}
