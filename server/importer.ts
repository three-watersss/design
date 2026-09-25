import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
export interface ImportRow {
  row: number;
  account: string;
  topic: string;
  error: string | null;
  duplicate: boolean;
}
function cellText(cell: ExcelJS.Cell) {
  const v = cell.value;
  if (v && typeof v === "object" && "formula" in v)
    return String(v.result ?? "").trim();
  return cell.text.trim();
}
export async function previewImport(store: Store, buffer: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as any);
  const sheet = book.worksheets[0];
  if (!sheet) throw Error("工作簿没有工作表");
  if (sheet.rowCount > 5001) throw Error("单次最多导入 5000 条选题");
  const headers = sheet.getRow(1);
  let a = 0,
    t = 0;
  headers.eachCell((c, n) => {
    if (cellText(c) === "账号名") a = n;
    if (cellText(c) === "主题") t = n;
  });
  if (!a || !t) throw Error("第一张工作表必须包含「账号名」和「主题」两列");
  const seen = new Set(
    store.tasks().map((x) => JSON.stringify([x.account, x.topic])),
  );
  const rows: ImportRow[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n),
      account = cellText(row.getCell(a)),
      topic = cellText(row.getCell(t));
    if (!account && !topic) continue;
    const key = JSON.stringify([account, topic]);
    const error =
      !account || !topic
        ? "账号或主题为空"
        : account.length > 100 || topic.length > 1000
          ? "账号或主题过长"
          : null;
    rows.push({ row: n, account, topic, error, duplicate: seen.has(key) });
    if (!error) seen.add(key);
  }
  if (!rows.length) throw Error("没有可导入的选题");
  const id = randomUUID();
  store.db
    .prepare("DELETE FROM imports WHERE created_at<?")
    .run(Date.now() - 86400000);
  store.db
    .prepare("INSERT INTO imports VALUES(?,?,?,NULL)")
    .run(id, JSON.stringify(rows), Date.now());
  return { id, rows };
}
export function commitImport(
  store: Store,
  id: string,
  keepDuplicates: boolean,
) {
  return store.transaction(() => {
    const record = store.db
      .prepare("SELECT * FROM imports WHERE id=?")
      .get(id) as any;
    if (!record) throw Error("导入预览已过期，请重新上传");
    if (record.result) return JSON.parse(record.result) as string[];
    const rows = JSON.parse(record.rows) as ImportRow[];
    const seen = new Set(
      store.tasks().map((x) => JSON.stringify([x.account, x.topic])),
    );
    const ids: string[] = [];
    for (const row of rows) {
      const key = JSON.stringify([row.account, row.topic]);
      if (row.error || (!keepDuplicates && seen.has(key))) continue;
      ids.push(store.add(row.account, row.topic));
      seen.add(key);
    }
    store.db
      .prepare("UPDATE imports SET result=? WHERE id=?")
      .run(JSON.stringify(ids), id);
    return ids;
  });
}
