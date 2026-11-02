import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function acquireSchedulerLock(path: string): { close(): void } {
  if (path === ":memory:" || path.startsWith("\\\\") || path.startsWith("//")) throw new Error("scheduler lock requires a shared local file");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  try { chmodSync(path, 0o600); } catch {}
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner_lock (id INTEGER PRIMARY KEY);");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    throw new Error(`cannot acquire goal scheduler lock: ${String(error)}`);
  }
  let closed = false;
  return { close() {
    if (closed) return;
    closed = true;
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  } };
}
