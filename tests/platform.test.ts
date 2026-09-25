import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeCommand, desktopCommand } from "../scripts/platform.ts";
import { loadConfig, readPrompt } from "../server/config.ts";

test("Windows npm/codex shims resolve without shell interpolation", () => {
  const shim = "C:\\Users\\测试 & User\\AppData\\Roaming\\npm\\codex.cmd";
  const entry =
    "C:\\Users\\测试 & User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const args = [
    "exec",
    "--image",
    "C:\\素材 & 发布\\图.png",
    "$(ignored) & %PATH%",
  ];
  assert.deepEqual(
    nodeCommand(
      "codex",
      args,
      "win32",
      () => [shim],
      (s) => s === entry,
    ),
    { bin: process.execPath, args: [entry, ...args] },
  );
  assert.deepEqual(
    nodeCommand(
      "npm",
      ["ci"],
      "win32",
      () => ["C:\\Program Files\\nodejs\\npm.cmd"],
      () => true,
    ),
    {
      bin: process.execPath,
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "ci",
      ],
    },
  );
  assert.deepEqual(nodeCommand("C:/Tools/codex.exe", args, "win32"), {
    bin: "C:/Tools/codex.exe",
    args,
  });
  assert.throws(
    () =>
      nodeCommand(
        "custom.cmd",
        args,
        "win32",
        () => ["C:\\custom.cmd"],
        () => false,
      ),
    /无法解析/,
  );
  assert.deepEqual(nodeCommand("codex", args, "darwin"), {
    bin: "codex",
    args,
  });
});

test("desktop commands pass paths as a single argument on both platforms", () => {
  const directory = "C:\\Users\\测试 & User\\images";
  assert.deepEqual(desktopCommand(directory, true, "win32"), {
    bin: "explorer.exe",
    args: [directory],
  });
  assert.deepEqual(desktopCommand("http://127.0.0.1:4317", false, "win32"), {
    bin: "explorer.exe",
    args: ["http://127.0.0.1:4317"],
  });
  assert.deepEqual(desktopCommand("/tmp/素材", true, "darwin"), {
    bin: "/usr/bin/open",
    args: ["-a", "Finder", "/tmp/素材"],
  });
});

test("fresh setup requires copying the template, then accepts local overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-config-"));
  try {
    assert.throws(() => loadConfig(root), /config.toml.eaxmple/);
    fs.copyFileSync("config.toml.eaxmple", path.join(root, "config.toml"));
    assert.equal(loadConfig(root).concurrency, 3);
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace("max_concurrency = 3", "max_concurrency = 1"),
    );
    assert.equal(loadConfig(root).concurrency, 1);
    fs.mkdirSync(path.join(root, "prompts"));
    fs.writeFileSync(
      path.join(root, "prompts/images.md"),
      "{{account}}（可替换参数） {{topic}}（可变参数）",
    );
    assert.equal(
      readPrompt(loadConfig(root), "images", "momo", "工业机器人"),
      "momo（可替换参数） 工业机器人（可变参数）",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
