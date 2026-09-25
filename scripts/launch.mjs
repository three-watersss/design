import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { nodeCommand, openDesktop } from "./platform.ts";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("需要 Node.js 24 或更新版本。请安装后重新启动。");
  process.exit(1);
}
if (!fs.existsSync("config.toml")) {
  console.error(
    "缺少 config.toml。请复制 config.toml.eaxmple 为 config.toml，填写代理等设置后重新启动。",
  );
  process.exit(1);
}
const port = Number(
    fs.readFileSync("config.toml", "utf8").match(/^port\s*=\s*(\d+)/m)?.[1] ??
      4317,
  ),
  url = `http://127.0.0.1:${port}`;
async function existing() {
  try {
    const r = await fetch(url + "/api/health", {
      signal: AbortSignal.timeout(1200),
    });
    const h = await r.json();
    return h.app === "material-studio" && h.root === root;
  } catch {
    return false;
  }
}
async function open() {
  if (process.env.STUDIO_NO_OPEN !== "1")
    await openDesktop(url).catch((e) =>
      console.error("自动打开浏览器失败，请手动访问：", url, e.message),
    );
  console.log("打开素材工作台：" + url);
}
if (await existing()) {
  await open();
  process.exit(0);
}
const lock = path.join(root, ".launch-lock");
try {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
} catch {
  try {
    const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
    process.kill(pid, 0);
    console.log("正在启动，请稍候…");
    for (let i = 0; i < 180; i++) {
      if (await existing()) {
        await open();
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error("启动未完成，请查看另一个终端窗口");
  } catch (e) {
    if (
      e.code !== "ESRCH" &&
      !(e.code === "ENOENT" && Date.now() - fs.statSync(lock).mtimeMs > 10000)
    )
      throw e;
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  }
}
const unlock = () => fs.rmSync(lock, { recursive: true, force: true });
process.on("exit", unlock);
function run(command, args, env = process.env) {
  const resolved = nodeCommand(command, args);
  const result = spawnSync(resolved.bin, resolved.args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw Error(`${command} 执行失败`);
}
try {
  const stamp = "node_modules/.material-studio-dependencies.sha256";
  const fingerprint = createHash("sha256")
    .update(fs.readFileSync("package-lock.json"))
    .update(fs.readFileSync("package.json"))
    .update(process.versions.node.split(".")[0])
    .update(process.platform)
    .update(process.arch)
    .digest("hex");
  if (
    !fs.existsSync("node_modules/tsx") ||
    !fs.existsSync(stamp) ||
    fs.readFileSync(stamp, "utf8") !== fingerprint
  ) {
    console.log("首次启动或依赖发生变化，正在安装依赖…");
    const proxy = fs
      .readFileSync("config.toml", "utf8")
      .match(/^proxy\s*=\s*"([^"]+)"/m)?.[1];
    run("npm", ["ci", "--no-audit", "--no-fund"], {
      ...process.env,
      ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
    });
    fs.writeFileSync(stamp, fingerprint);
  }
  console.log("正在准备界面…");
  run("npm", ["run", "build"]);
  const log = fs.openSync(path.join(root, "startup.log"), "a");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 60; i++) {
    if (await existing()) {
      await open();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error(
    "服务启动失败。请查看项目目录中的 startup.log（端口可能被占用）。",
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
