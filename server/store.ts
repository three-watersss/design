import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
export type Stage = "images" | "copy";
export type State =
  | "queued_images"
  | "running_images"
  | "review_images"
  | "queued_copy"
  | "running_copy"
  | "review_copy"
  | "ready"
  | "published"
  | "cleaning"
  | "failed"
  | "blocked";
export interface Task {
  id: string;
  account: string;
  topic: string;
  state: State;
  stage: Stage;
  version: number;
  attempt_id: string | null;
  image_attempt: string | null;
  copy_attempt: string | null;
  retry_prompt: string | null;
  failures: number;
  next_at: number;
  created_at: number;
  updated_at: number;
  queued_at: number;
  published_at: number | null;
  error: string | null;
  progress: string;
  title: string | null;
  body: string | null;
  warning: string | null;
}
export interface Attempt {
  id: string;
  task_id: string;
  stage: Stage;
  status: string;
  prompt: string | null;
  thread_id: string | null;
  pid: number | null;
  started_at: number;
  finished_at: number | null;
  cleanup_action: string | null;
  error_kind: string | null;
}
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,account TEXT NOT NULL,topic TEXT NOT NULL,state TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'images',version INTEGER NOT NULL DEFAULT 0,attempt_id TEXT,image_attempt TEXT,copy_attempt TEXT,retry_prompt TEXT,failures INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,queued_at INTEGER NOT NULL,published_at INTEGER,error TEXT,progress TEXT NOT NULL DEFAULT '',title TEXT,body TEXT,warning TEXT);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),stage TEXT NOT NULL,status TEXT NOT NULL,prompt TEXT,thread_id TEXT,pid INTEGER,started_at INTEGER NOT NULL,finished_at INTEGER,cleanup_action TEXT,error_kind TEXT);
 CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),position INTEGER NOT NULL,path TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,sha256 TEXT NOT NULL,UNIQUE(attempt_id,position));
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,rows TEXT NOT NULL,created_at INTEGER NOT NULL,result TEXT);
 CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(state,next_at,queued_at);
 CREATE INDEX IF NOT EXISTS tasks_account ON tasks(account,topic);
 PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  task(id: string) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(id) as unknown as Task | undefined;
  }
  tasks() {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC,rowid DESC")
      .all() as unknown as Task[];
  }
  attempt(id: string) {
    return this.db
      .prepare("SELECT * FROM attempts WHERE id=?")
      .get(id) as unknown as Attempt | undefined;
  }
  assets(id: string) {
    return this.db
      .prepare("SELECT * FROM assets WHERE task_id=? ORDER BY position")
      .all(id) as any[];
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    return row ? JSON.parse(row.value) : fallback;
  }
  add(account: string, topic: string) {
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO tasks(id,account,topic,state,created_at,updated_at,queued_at) VALUES(?,?,?,'queued_images',?,?,?)",
      )
      .run(id, account, topic, now, now, now);
    return id;
  }
  update(id: string, patch: Partial<Task>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const allowed = new Set([
      "state",
      "stage",
      "attempt_id",
      "image_attempt",
      "copy_attempt",
      "retry_prompt",
      "failures",
      "next_at",
      "published_at",
      "error",
      "progress",
      "title",
      "body",
      "warning",
      "queued_at",
    ]);
    if (keys.some((k) => !allowed.has(k))) throw Error("Invalid task update");
    this.db
      .prepare(
        `UPDATE tasks SET ${keys.map((k) => k + "=?").join(",")},updated_at=?,version=version+1 WHERE id=?`,
      )
      .run(...keys.map((k) => (patch as any)[k]), Date.now(), id);
  }
  close() {
    this.db.close();
  }
}
