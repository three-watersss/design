import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("需要 Node.js 24 或更新版本。请安装后重新启动。");
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
function open() {
  if (process.env.STUDIO_NO_OPEN !== "1")
    spawn("open", [url], { stdio: "ignore" });
  console.log("打开素材工作台：" + url);
}
if (await existing()) {
  open();
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
        open();
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
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) throw Error(`${command} 执行失败`);
}
try {
  if (!fs.existsSync("node_modules/tsx")) {
    console.log("首次启动，正在安装依赖…");
    const proxy = fs
      .readFileSync("config.toml", "utf8")
      .match(/^proxy\s*=\s*"([^"]+)"/m)?.[1];
    run("npm", ["ci", "--no-audit", "--no-fund"], {
      ...process.env,
      ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
    });
  }
  console.log("正在准备界面…");
  run("npm", ["run", "build"]);
  const log = fs.openSync(path.join(root, "startup.log"), "a");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    { cwd: root, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 60; i++) {
    if (await existing()) {
      open();
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
