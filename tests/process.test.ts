import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stopWorker } from "../server/runner.ts";
import type { Config } from "../server/config.ts";
async function workerFixture(timeoutMs: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-process-")),
    id = randomUUID(),
    dir = path.join(root, "attempts", id);
  fs.mkdirSync(dir, { recursive: true });
  const ownerFile = path.join(root, "owner.json");
  fs.writeFileSync(ownerFile, JSON.stringify({ nonce: "test" }));
  fs.writeFileSync(
    path.join(dir, "request.json"),
    JSON.stringify({
      parent: process.pid,
      nonce: "test",
      ownerFile,
      proxy: "http://127.0.0.1:7897",
      bin: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"],
      prompt: "test",
      timeoutMs,
    }),
  );
  const child = spawn(
    process.execPath,
    [path.resolve("scripts/cli-worker.mjs"), dir],
    { stdio: "ignore" },
  );
  const finished = new Promise<number | null>((r) => child.on("exit", r));
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "worker.json")); i++)
    await new Promise((r) => setTimeout(r, 10));
  return { root, id, dir, ownerFile, child, finished };
}
test("supervisor enforces stage timeout and records interrupted output", async () => {
  const x = await workerFixture(100);
  try {
    assert.equal(await x.finished, 1);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(x.dir, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.kind, "timeout");
    assert.notEqual(receipt.exitCode, 0);
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});
test("supervisor stops when parent owner changes, preventing orphan CLI work", async () => {
  const x = await workerFixture(10000);
  try {
    fs.writeFileSync(x.ownerFile, JSON.stringify({ nonce: "new-server" }));
    assert.equal(await x.finished, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(x.dir, "receipt.json"), "utf8"))
        .kind,
      "interrupted",
    );
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});
test("recovery can stop a verified worker without killing unrelated processes", async () => {
  const x = await workerFixture(10000);
  try {
    await stopWorker(
      { dataDir: x.root } as Config,
      { id: x.id, pid: x.child.pid } as any,
    );
    assert.equal(await x.finished, 1);
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});

test("nonce-bound stop request gracefully ends the CLI supervisor", async () => {
  const x = await workerFixture(10000);
  try {
    fs.writeFileSync(
      path.join(x.dir, "stop.json"),
      JSON.stringify({ pid: x.child.pid, nonce: "wrong" }),
    );
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(fs.existsSync(path.join(x.dir, "receipt.json")), false);
    fs.writeFileSync(
      path.join(x.dir, "stop.json"),
      JSON.stringify({ pid: x.child.pid, nonce: "test" }),
    );
    assert.equal(await x.finished, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(x.dir, "receipt.json"), "utf8"))
        .kind,
      "interrupted",
    );
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});
