import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { createRunner } from "./runner.ts";
import { Service } from "./service.ts";
import { createApp } from "./api.ts";
const c = loadConfig();
const lock = path.join(c.dataDir, ".instance"),
  ownerFile = path.join(lock, "owner.json"),
  nonce = randomUUID();
try {
  fs.mkdirSync(lock);
} catch {
  let alive = true;
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    try {
      process.kill(owner.pid, 0);
    } catch {
      alive = false;
    }
  } catch {
    alive = Date.now() - fs.statSync(lock).mtimeMs < 10000;
  }
  if (alive) {
    console.error("工具已经运行，或正在启动。请双击启动入口打开已有页面。");
    process.exit(1);
  }
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
}
fs.writeFileSync(
  ownerFile,
  JSON.stringify({ pid: process.pid, nonce, root: c.root }),
);
const store = new Store(path.join(c.dataDir, "materials.sqlite"));
const service = new Service(c, store, createRunner(c), ownerFile, nonce);
const app = createApp(service);
let ending = false;
const server = app.listen(c.port, "127.0.0.1", () => {
  console.log(`素材工作台：http://127.0.0.1:${c.port}`);
  void service.start().catch((e) => {
    store.set("blocked", `恢复检查失败：${e.message}`);
    service.notify();
    console.error(e.message);
  });
});
server.on("error", (e) => {
  console.error("启动失败：", e.message);
  void shutdown();
});
// Windows SIGTERM cannot run Node cleanup handlers; the local stop script
// requests shutdown using this instance's nonce instead of terminating Node.
const stopWatch = setInterval(() => {
  try {
    const request = JSON.parse(
      fs.readFileSync(path.join(lock, "stop.json"), "utf8"),
    );
    if (request.pid === process.pid && request.nonce === nonce) void shutdown();
  } catch {}
}, 500);
stopWatch.unref();
async function shutdown() {
  if (ending) return;
  ending = true;
  clearInterval(stopWatch);
  await service.shutdown();
  server.closeAllConnections();
  server.close();
  store.close();
  try {
    if (JSON.parse(fs.readFileSync(ownerFile, "utf8")).nonce === nonce)
      fs.rmSync(lock, { recursive: true, force: true });
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("uncaughtException", (e) => {
  console.error("服务异常：", e.message);
  void shutdown();
});
