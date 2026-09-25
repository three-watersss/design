import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

function windowsCommands(name: string): string[] {
  const directories =
    name.includes("/") || name.includes("\\")
      ? [process.cwd()]
      : [process.cwd(), ...(process.env.PATH ?? "").split(";")];
  return directories.flatMap((directory) => {
    const base = path.win32.resolve(directory.replace(/^"|"$/g, ""), name);
    return ["", ".exe", ".cmd", ".bat"]
      .map((ext) => base + ext)
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  });
}

// Resolve npm's Windows shims to JS entrypoints without passing model arguments
// through cmd.exe (prompts and file paths may contain shell metacharacters).
export function nodeCommand(
  command: string,
  args: string[],
  platform = process.platform,
  locate = windowsCommands,
  exists = fs.existsSync,
): { bin: string; args: string[] } {
  if (platform !== "win32") return { bin: command, args };
  if (/\.m?js$/i.test(command))
    return { bin: process.execPath, args: [command, ...args] };
  if (/\.exe$/i.test(command)) return { bin: command, args };
  const candidates = path.win32.isAbsolute(command)
    ? [command]
    : locate(command);
  for (const candidate of candidates) {
    if (/\.exe$/i.test(candidate)) return { bin: candidate, args };
    const name = path.win32
      .basename(candidate)
      .replace(/\.(cmd|bat|ps1)$/i, "")
      .toLowerCase();
    const entry =
      name === "npm"
        ? "node_modules/npm/bin/npm-cli.js"
        : name === "codex"
          ? "node_modules/@openai/codex/bin/codex.js"
          : null;
    if (entry) {
      const script = path.win32.join(path.win32.dirname(candidate), entry);
      if (exists(script))
        return { bin: process.execPath, args: [script, ...args] };
    }
  }
  throw Error(
    `无法解析 ${command}。请使用 npm 标准安装，或将 codex_bin 指向 codex.exe / codex.js 的绝对路径。`,
  );
}

export function processCommand(
  pid: number,
  platform = process.platform,
): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("无效进程编号");
  if (platform === "win32") {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    ).trim();
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function desktopCommand(
  target: string,
  folder = false,
  platform = process.platform,
) {
  if (platform === "darwin")
    return {
      bin: "/usr/bin/open",
      args: folder ? ["-a", "Finder", target] : [target],
    };
  if (platform === "win32") return { bin: "explorer.exe", args: [target] };
  throw Error("当前快捷入口仅支持 macOS 和 Windows");
}

export async function openDesktop(target: string, folder = false) {
  const command = desktopCommand(target, folder);
  // Explorer can return 1 when handing off to an existing desktop process.
  // Successful spawn means the OS accepted the request, not that a window was inspected.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
