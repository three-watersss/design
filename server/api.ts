import express from "express";
import multer from "multer";
import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Service, Conflict } from "./service.ts";
import { attemptDir } from "./runner.ts";
import { previewImport, commitImport } from "./importer.ts";
async function openImageFolder(directory: string) {
  if (process.platform !== "darwin")
    throw Error("当前版本仅支持在 Mac 上打开图片文件夹");
  try {
    await promisify(execFile)("/usr/bin/open", ["-a", "Finder", directory], {
      timeout: 10000,
    });
  } catch {
    throw Error("无法打开 Finder，请检查本地图片目录权限后重试");
  }
}
export function createApp(service: Service, openFolder = openImageFolder) {
  const app = express(),
    c = service.c;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const hosts = new Set([`127.0.0.1:${c.port}`, `localhost:${c.port}`]);
    if (!hosts.has(req.headers.host ?? ""))
      return res.status(403).json({ error: "仅允许本机访问" });
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([
        `http://127.0.0.1:${c.port}`,
        `http://localhost:${c.port}`,
      ]).has(origin)
    )
      return res.status(403).json({ error: "不允许跨站请求" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (_req, res) =>
    res.json({ app: "material-studio", root: c.root, version: "1.0.0" }),
  );
  app.get("/api/state", (_req, res) => res.json(service.snapshot()));
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    res.write("data: {}\n\n");
    const change = () => res.write("data: {}\n\n");
    service.on("change", change);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      service.off("change", change);
    });
  });
  app.post("/api/check", async (_req, res) => {
    await service.check();
    res.json(service.snapshot());
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });
  app.post("/api/import/preview", upload.single("file"), async (req, res) => {
    if (!req.file || !req.file.originalname.toLowerCase().endsWith(".xlsx"))
      throw Error("请选择 .xlsx 选题表");
    res.json(await previewImport(service.store, req.file.buffer));
  });
  app.post("/api/import/commit", (req, res) => {
    if (typeof req.body.id !== "string") throw Error("缺少预览编号");
    const ids = commitImport(
      service.store,
      req.body.id,
      req.body.keepDuplicates === true,
    );
    service.notify();
    void service.tick();
    res.json({ ids });
  });
  const action =
    (handler: (id: string, v: number) => unknown) =>
    async (req: express.Request, res: express.Response) => {
      if (!Number.isInteger(req.body.version)) throw Error("缺少任务状态版本");
      await handler(String(req.params.id), req.body.version);
      res.json(service.snapshot());
    };
  app.post(
    "/api/tasks/:id/approve",
    action((id, v) => service.approve(id, v)),
  );
  app.post(
    "/api/tasks/:id/regenerate",
    action((id, v) => service.regenerate(id, v)),
  );
  app.post(
    "/api/tasks/:id/retry",
    action((id, v) => service.retry(id, v)),
  );
  app.post(
    "/api/tasks/:id/publish",
    action((id, v) => service.publish(id, v)),
  );
  app.delete(
    "/api/materials/:id",
    action((id, v) => service.deleteMaterial(id, v)),
  );
  app.post("/api/queue", async (req, res) => {
    if (typeof req.body.paused !== "boolean") throw Error("缺少暂停状态");
    await service.pause(req.body.paused);
    res.json(service.snapshot());
  });
  app.post("/api/publish/pick", (req, res) => {
    const excluded = req.body.excluded ?? [];
    if (
      !Array.isArray(excluded) ||
      excluded.length > 10000 ||
      excluded.some((x) => typeof x !== "string")
    )
      throw Error("换组参数无效");
    res.json({ task: service.pick(String(req.body.account ?? ""), excluded) });
  });
  function safeAsset(relative: string) {
    const file = path.resolve(c.dataDir, relative);
    if (
      !file.startsWith(c.dataDir + path.sep) ||
      !fs.existsSync(file) ||
      !fs.realpathSync(file).startsWith(fs.realpathSync(c.dataDir) + path.sep)
    )
      throw Error("素材文件不存在");
    return file;
  }
  app.post("/api/materials/:id/open-images", async (req, res) => {
    const t = service.store.task(String(req.params.id));
    if (!t) throw new Conflict("素材不存在或已删除");
    if (!["ready", "published"].includes(t.state))
      throw new Conflict("只能打开完整素材的图片文件夹");
    if (!t.image_attempt) throw Error("素材缺少图片目录记录");
    const images = service.store.assets(t.id);
    if (!images.length) throw Error("暂无图片");
    const directory = safeAsset(
      path.relative(
        c.dataDir,
        path.join(attemptDir(c, t.image_attempt), "images"),
      ),
    );
    if (!fs.statSync(directory).isDirectory()) throw Error("图片目录不存在");
    const realDirectory = fs.realpathSync(directory) + path.sep;
    for (const image of images) {
      if (
        image.attempt_id !== t.image_attempt ||
        !fs.realpathSync(safeAsset(image.path)).startsWith(realDirectory)
      )
        throw Error("素材图片目录不一致，请检查本地文件");
    }
    await openFolder(directory);
    res.json({ ok: true });
  });
  app.get("/api/assets/:id", (req, res) => {
    const a = service.store.db
      .prepare("SELECT * FROM assets WHERE id=?")
      .get(req.params.id) as any;
    if (!a) return res.status(404).end();
    res.setHeader("Cache-Control", "private, max-age=60");
    res.sendFile(safeAsset(a.path));
  });
  app.get("/api/tasks/:id/download", async (req, res) => {
    const t = service.store.task(req.params.id);
    if (!t) throw Error("素材不存在");
    const assets = service.store.assets(t.id);
    if (!assets.length) throw Error("暂无图片");
    res.attachment(`materials-${t.id.slice(0, 8)}.zip`);
    const zip = archiver("zip", { zlib: { level: 5 } });
    zip.on("error", () => res.destroy());
    res.on("close", () => zip.abort());
    zip.pipe(res);
    for (const a of assets)
      zip.file(safeAsset(a.path), {
        name: `images/${String(a.position + 1).padStart(2, "0")}${path.extname(a.path)}`,
      });
    if (req.query.imagesOnly !== "true") {
      zip.append([t.title, t.body].filter(Boolean).join("\n\n"), {
        name: "copy.txt",
      });
      zip.append(
        JSON.stringify(
          {
            account: t.account,
            topic: t.topic,
            status: t.state,
            published_at: t.published_at,
          },
          null,
          2,
        ),
        { name: "material.json" },
      );
    }
    await zip.finalize();
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(express.static(path.join(c.root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(c.root, "dist", "index.html")),
  );
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error instanceof Conflict ? 409 : 400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "文件过大，最大 20 MB"
            : (error.message ?? "操作失败"),
      });
    },
  );
  return app;
}
