import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Service } from "../server/service.ts";
import { createApp } from "../server/api.ts";
import type { Config } from "../server/config.ts";

test("HTTP import, version conflicts, publication and cross-origin protection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-api-"));
  const c: Config = {
    root,
    dataDir: root,
    port: 0,
    model: "test",
    effort: "high",
    concurrency: 3,
    timeoutMs: 1000,
    codex: "codex",
    proxy: "http://127.0.0.1:7897",
  };
  const store = new Store(path.join(root, "test.sqlite"));
  const service = new Service(
    c,
    store,
    async () => {
      throw Error("must remain paused");
    },
    "",
    "",
    async () => [],
  );
  store.set("paused", true);
  const openedFolders: string[] = [];
  const server = createApp(service, async (directory) => {
    openedFolders.push(directory);
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  c.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${c.port}`;
  const post = (url: string, data: unknown) =>
    fetch(base + url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await fetch(base + "/api/health")).status, 200);
    assert.equal(
      (
        await fetch(base + "/api/state", {
          headers: { Origin: "https://elsewhere.example" },
        })
      ).status,
      403,
    );
    const book = new ExcelJS.Workbook();
    book.addWorksheet("topics").addRows([
      ["账号名", "主题"],
      ["momo", "机器人"],
    ]);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await book.xlsx.writeBuffer())]),
      "topics.xlsx",
    );
    const preview = (await (
      await fetch(base + "/api/import/preview", { method: "POST", body: form })
    ).json()) as any;
    const committed = (await (
      await post("/api/import/commit", { id: preview.id })
    ).json()) as any;
    assert.equal(committed.ids.length, 1);
    const id = committed.ids[0];
    assert.equal(
      (await post(`/api/tasks/${id}/approve`, { version: 0 })).status,
      409,
    );
    store.update(id, { state: "review_copy", title: "标题", body: "正文" });
    const attempt = randomUUID(),
      asset = randomUUID();
    store.db
      .prepare(
        "INSERT INTO attempts(id,task_id,stage,status,started_at) VALUES(?,?,?,?,?)",
      )
      .run(attempt, id, "images", "done", Date.now());
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const imageDir = path.join(root, "attempts", attempt, "images");
    fs.mkdirSync(imageDir, { recursive: true });
    const imagePath = path.join(imageDir, "original.png");
    fs.writeFileSync(imagePath, png);
    store.update(id, { image_attempt: attempt });
    store.db
      .prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)")
      .run(asset, id, attempt, 0, path.relative(root, imagePath), 2, 2, "test");
    assert.equal(
      (await post(`/api/materials/${id}/open-images`, {})).status,
      409,
    );
    assert.equal(openedFolders.length, 0);
    const image = await fetch(base + "/api/assets/" + asset);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const archive = await fetch(base + `/api/tasks/${id}/download`);
    assert.equal(archive.status, 200);
    const zip = Buffer.from(await archive.arrayBuffer());
    assert.equal(zip.readUInt32LE(), 0x04034b50);
    for (const name of ["images/01.png", "copy.txt", "material.json"])
      assert.ok(zip.includes(Buffer.from(name)));
    const imagesOnly = Buffer.from(
      await (
        await fetch(base + `/api/tasks/${id}/download?imagesOnly=true`)
      ).arrayBuffer(),
    );
    assert.ok(!imagesOnly.includes(Buffer.from("copy.txt")));
    const version = store.task(id)!.version;
    assert.equal(
      (await post(`/api/tasks/${id}/approve`, { version })).status,
      200,
    );
    assert.equal(
      (await post(`/api/tasks/${id}/approve`, { version })).status,
      409,
    );
    assert.equal(
      (await post(`/api/materials/${id}/open-images`, { path: "/" })).status,
      200,
    );
    assert.deepEqual(openedFolders, [imageDir]);
    fs.renameSync(imagePath, imagePath + ".tmp");
    assert.equal(
      (await post(`/api/materials/${id}/open-images`, {})).status,
      400,
    );
    assert.equal(openedFolders.length, 1);
    fs.renameSync(imagePath + ".tmp", imagePath);
    assert.equal(
      (await post("/api/materials/missing/open-images", {})).status,
      409,
    );
    const picked = (await (
      await post("/api/publish/pick", { excluded: [] })
    ).json()) as any;
    assert.equal(picked.task.id, id);
    assert.equal(
      (
        (await (
          await post("/api/publish/pick", { excluded: [id] })
        ).json()) as any
      ).task,
      null,
    );
    assert.equal(
      (
        await post(`/api/tasks/${id}/publish`, {
          version: store.task(id)!.version,
        })
      ).status,
      200,
    );
    assert.equal(store.task(id)!.state, "published");
    assert.ok(store.task(id)!.published_at);
    const remove = (taskId: string, version: number) =>
      fetch(base + "/api/materials/" + taskId, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
    assert.equal((await remove(id, store.task(id)!.version)).status, 409);
    const disposable = store.add("test", "API deletion");
    store.update(disposable, { state: "ready", title: "test", body: "test" });
    const deleteVersion = store.task(disposable)!.version;
    assert.equal((await remove(disposable, deleteVersion - 1)).status, 409);
    assert.equal((await remove(disposable, deleteVersion)).status, 200);
    assert.equal(store.task(disposable), undefined);
    assert.equal((await remove(disposable, deleteVersion)).status, 200);
    const controller = new AbortController();
    const events = await fetch(base + "/api/events", {
      signal: controller.signal,
    });
    const reader = events.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /data:/,
    );
    controller.abort();
  } finally {
    await service.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
