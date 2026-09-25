import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processCommand } from "./platform.ts";
import { parse } from "smol-toml";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  c = parse(fs.readFileSync(path.join(root, "config.toml"), "utf8"));
const owner = path.resolve(root, c.server.data_dir, ".instance/owner.json");
try {
  const { pid, nonce } = JSON.parse(fs.readFileSync(owner, "utf8"));
  const command = processCommand(pid);
  if (!command.replaceAll("\\", "/").includes("server/index.ts"))
    throw Error("进程不匹配，未停止任何程序");
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(path.dirname(owner), "stop.json"),
      JSON.stringify({ pid, nonce }),
    );
  } else process.kill(pid, "SIGTERM");
  console.log("正在结束当前生成进程并停止服务…");
  let stopped = false;
  for (let n = 0; n < 150; n++) {
    try {
      process.kill(pid, 0);
    } catch {
      stopped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!stopped) throw Error("服务仍在退出，请稍后再启动。");
  console.log("素材工作台已停止，未完成任务将在下次启动恢复。");
} catch (e) {
  console.log(e.code === "ENOENT" ? "素材工作台尚未运行。" : e.message);
  if (e.code !== "ENOENT") process.exitCode = 1;
}
