// Supervisor owns the CLI process group, including after the UI/server exits.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { nodeCommand } from "./platform.ts";
const dir = process.argv[2];
const job = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
const atomic = (name, value) => {
  fs.writeFileSync(path.join(dir, name + ".tmp"), JSON.stringify(value));
  fs.renameSync(path.join(dir, name + ".tmp"), path.join(dir, name));
};
atomic("worker.json", {
  pid: process.pid,
  parent: job.parent,
  nonce: job.nonce,
});
let child,
  ending = false,
  timedOut = false;
function stop() {
  if (ending) return;
  ending = true;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 3000).unref();
}
const env = { ...process.env };
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[key];
for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
])
  env[key] = job.proxy;
env.NO_PROXY = "localhost,127.0.0.1,::1";
env.no_proxy = env.NO_PROXY;
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
let diagnostic = "";
try {
  const command = nodeCommand(job.bin, job.args);
  child = spawn(command.bin, command.args, {
    cwd: dir,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    try {
      process.stdout.write(b);
    } catch {}
  });
  child.stderr.on("data", (b) => {
    diagnostic = (diagnostic + b.toString()).slice(-8000);
  });
  child.on("error", (e) => {
    atomic("receipt.json", { exitCode: 127, kind: "cli", message: e.message });
    process.exit(1);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(job.prompt);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, job.timeoutMs);
  const watch = setInterval(() => {
    try {
      process.kill(job.parent, 0);
      const owner = JSON.parse(fs.readFileSync(job.ownerFile, "utf8"));
      if (owner.nonce !== job.nonce) stop();
      const stopFile = path.join(dir, "stop.json");
      if (fs.existsSync(stopFile)) {
        const request = JSON.parse(fs.readFileSync(stopFile, "utf8"));
        if (request.pid === process.pid && request.nonce === job.nonce) stop();
      }
    } catch {
      stop();
    }
  }, 1000);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    clearInterval(watch);
    atomic("receipt.json", {
      exitCode: code ?? 1,
      signal,
      kind: timedOut
        ? "timeout"
        : ending
          ? "interrupted"
          : code === 0
            ? "success"
            : "cli",
      message: code === 0 ? "" : diagnostic,
    });
    process.exit(code === 0 ? 0 : 1);
  });
} catch (e) {
  atomic("receipt.json", { exitCode: 1, kind: "cli", message: String(e) });
  process.exit(1);
}
