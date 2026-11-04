import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const checkpointSchema = z.strictObject({ commandId: z.string().min(1).max(200), expectedVersion: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(4000), remaining: z.array(z.string().trim().min(1).max(1000)).max(30),
  blockers: z.array(z.string().trim().min(1).max(1000)).max(20), nextStep: z.string().trim().min(1).max(2000) });
export const taskChangeSchema = z.strictObject({ commandId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(),
  instruction: z.string().trim().min(1).max(8000), externalStateChecked: z.literal(true) });

export function migrateTaskContinuity(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS goal_task_checkpoints (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES goals(id), task_id TEXT NOT NULL REFERENCES goal_tasks(id),
    attempt_id TEXT NOT NULL REFERENCES goal_attempts(id), task_revision INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_task_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES goals(id), task_id TEXT NOT NULL REFERENCES goal_tasks(id),
    kind TEXT NOT NULL CHECK(kind IN ('resume','amend','dependency_changed')), instruction TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS goal_checkpoint_task ON goal_task_checkpoints(task_id, seq);
    CREATE INDEX IF NOT EXISTS goal_change_task ON goal_task_changes(task_id, seq);`);
}

export function taskRevision(db: DatabaseSync, taskId: string): number {
  return 1 + Number(db.prepare("SELECT COUNT(*) AS n FROM goal_task_changes WHERE task_id=?").get(taskId)?.n);
}

export function taskContinuation(db: DatabaseSync, goalId: string, taskId: string) {
  const row = db.prepare("SELECT attempt_id, task_revision, checkpoint_json FROM goal_task_checkpoints WHERE goal_id=? AND task_id=? ORDER BY seq DESC LIMIT 1").get(goalId, taskId);
  const changes = db.prepare("SELECT kind, instruction FROM goal_task_changes WHERE goal_id=? AND task_id=? ORDER BY seq DESC LIMIT 20")
    .all(goalId, taskId).reverse().map(change => ({ kind: String(change.kind), instruction: String(change.instruction) }));
  return { taskRevision: taskRevision(db, taskId),
    ...(row ? { checkpoint: { trust: "unverified_executor_note" as const, attemptId: String(row.attempt_id), taskRevision: Number(row.task_revision),
      ...checkpointSchema.omit({ commandId: true, expectedVersion: true }).parse(JSON.parse(String(row.checkpoint_json))) } } : {}),
    changes, recoveryRule: "Inspect current files and external action receipts before continuing. Checkpoint notes are not acceptance evidence. Do not repeat an external action merely because its local receipt is missing." };
}

export function affectedTasks(db: DatabaseSync, goalId: string, taskId: string): string[] {
  return db.prepare(`WITH RECURSIVE affected(id) AS (SELECT id FROM goal_tasks WHERE id=? AND goal_id=?
    UNION SELECT d.task_id FROM goal_dependencies d JOIN affected a ON d.depends_on_id=a.id WHERE d.goal_id=?)
    SELECT id FROM affected ORDER BY id`).all(taskId, goalId, goalId).map(row => String(row.id));
}

export function assertTasksStopped(db: DatabaseSync, goalId: string, taskIds: readonly string[], confirmStopped: (rootId: string) => boolean): void {
  for (const taskId of taskIds) {
    for (const table of ["goal_attempts", "goal_review_attempts"]) {
      const runs = db.prepare(`SELECT root_id, status FROM ${table} WHERE goal_id=? AND task_id=?`).all(goalId, taskId);
      if (runs.some(run => !["succeeded", "failed", "cancelled", "applied", "rejected"].includes(String(run.status)) ||
        confirmStopped(String(run.root_id)) !== true)) throw new Error("task execution stop is not confirmed");
    }
  }
}

export function invalidateTaskEvidence(db: DatabaseSync, goalId: string, taskId: string): void {
  db.prepare("UPDATE goal_review_attempts SET status='rejected' WHERE goal_id=? AND task_id=? AND status IN ('applied','succeeded')").run(goalId, taskId);
  db.prepare("UPDATE goal_tasks SET status='planned' WHERE goal_id=? AND id=?").run(goalId, taskId);
  db.prepare("DELETE FROM goal_task_blockers WHERE task_id=?").run(taskId);
}
