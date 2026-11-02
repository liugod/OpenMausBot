import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const evidenceSchema = z.object({ attemptId: z.string().min(1), requirementRevision: z.number().int().positive(), planRevision: z.number().int().positive(),
  artifacts: z.array(z.object({ id: z.string().min(1), logicalName: z.string().min(1), sha256: z.string().min(1), bytes: z.number().int().nonnegative() })) });

export function bindTaskInputs(db: DatabaseSync, goalId: string, attemptId: string, dependencies: readonly string[]): void {
  const goal = db.prepare("SELECT requirement_revision, plan_revision FROM goals WHERE id=?").get(goalId);
  if (!goal) throw new Error("goal not found");
  for (const taskId of dependencies) {
    const task = db.prepare("SELECT status, plan_revision FROM goal_tasks WHERE id=? AND goal_id=?").get(taskId, goalId);
    const review = db.prepare("SELECT id, evidence_json FROM goal_review_attempts WHERE task_id=? AND goal_id=? AND status='applied' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId, goalId);
    if (!task || task.status !== "succeeded" || task.plan_revision !== goal.plan_revision || !review) throw new Error("dependency has no current accepted review");
    const evidence = evidenceSchema.parse(JSON.parse(String(review.evidence_json)));
    if (evidence.requirementRevision !== Number(goal.requirement_revision) || evidence.planRevision !== Number(goal.plan_revision)) throw new Error("dependency review is stale");
    db.prepare("INSERT INTO goal_attempt_dependencies VALUES (?, ?, ?, ?, ?)").run(attemptId, taskId, String(review.id), evidence.requirementRevision, evidence.planRevision);
    for (const artifact of evidence.artifacts) {
      const snapshot = db.prepare(`SELECT s.sha256, s.bytes, a.revision FROM goal_artifact_snapshots s JOIN goal_artifacts a ON a.id=s.artifact_id
        WHERE a.id=? AND a.goal_id=? AND a.task_id=? AND a.attempt_id=?`).get(artifact.id, goalId, taskId, evidence.attemptId);
      if (!snapshot || snapshot.sha256 !== artifact.sha256 || Number(snapshot.bytes) !== artifact.bytes) throw new Error("dependency artifact snapshot is unavailable");
      const latest = db.prepare("SELECT MAX(revision) AS revision FROM goal_artifacts WHERE task_id=? AND logical_name=?").get(taskId, artifact.logicalName);
      if (latest?.revision !== snapshot.revision) throw new Error("dependency artifact was superseded");
      db.prepare("INSERT INTO goal_attempt_inputs VALUES (?, ?, ?, ?, ?, ?)").run(attemptId, taskId, artifact.id, artifact.logicalName, artifact.sha256, artifact.bytes);
    }
  }
}

export function taskInputsCurrent(db: DatabaseSync, goalId: string, attemptId: string): boolean {
  return inputsCurrent(db, goalId, attemptId, new Set(), new Map());
}

function inputsCurrent(db: DatabaseSync, goalId: string, attemptId: string, visiting: Set<string>, memo: Map<string, boolean>): boolean {
  const cached = memo.get(attemptId);
  if (cached !== undefined) return cached;
  if (visiting.has(attemptId)) return false;
  visiting.add(attemptId);
  const valid = checkInputs(db, goalId, attemptId, visiting, memo);
  visiting.delete(attemptId);
  memo.set(attemptId, valid);
  return valid;
}

function checkInputs(db: DatabaseSync, goalId: string, attemptId: string, visiting: Set<string>, memo: Map<string, boolean>): boolean {
  const deps = db.prepare("SELECT * FROM goal_attempt_dependencies WHERE attempt_id=?").all(attemptId);
  const goal = db.prepare("SELECT requirement_revision, plan_revision FROM goals WHERE id=?").get(goalId);
  const task = db.prepare(`SELECT t.task_json FROM goal_attempts a JOIN goal_tasks t ON t.id=a.task_id AND t.goal_id=a.goal_id
    WHERE a.id=? AND a.goal_id=?`).get(attemptId, goalId);
  if (!goal || !task) return false;
  const expected = z.object({ dependsOn: z.array(z.string()) }).parse(JSON.parse(String(task.task_json))).dependsOn;
  if (expected.length !== deps.length || deps.some(dep => !expected.includes(String(dep.predecessor_task_id)))) return false;
  for (const dep of deps) {
    const predecessor = db.prepare("SELECT status, plan_revision FROM goal_tasks WHERE id=? AND goal_id=?").get(String(dep.predecessor_task_id), goalId);
    const review = db.prepare("SELECT id, evidence_json FROM goal_review_attempts WHERE task_id=? AND goal_id=? AND status='applied' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(String(dep.predecessor_task_id), goalId);
    if (!predecessor || predecessor.status !== "succeeded" || predecessor.plan_revision !== goal.plan_revision || review?.id !== dep.review_attempt_id ||
      dep.requirement_revision !== goal.requirement_revision || dep.plan_revision !== goal.plan_revision) return false;
    const evidence = evidenceSchema.parse(JSON.parse(String(review.evidence_json)));
    const sourceAttempt = db.prepare("SELECT task_id, status FROM goal_attempts WHERE id=? AND goal_id=?").get(evidence.attemptId, goalId);
    if (!sourceAttempt || sourceAttempt.task_id !== dep.predecessor_task_id || sourceAttempt.status !== "succeeded" ||
      !inputsCurrent(db, goalId, evidence.attemptId, visiting, memo)) return false;
    const inputs = db.prepare(`SELECT i.artifact_id, i.sha256, i.bytes, a.revision, a.logical_name, s.sha256 AS snapshot_sha, s.bytes AS snapshot_bytes
      FROM goal_attempt_inputs i JOIN goal_artifacts a ON a.id=i.artifact_id JOIN goal_artifact_snapshots s ON s.artifact_id=a.id
      WHERE i.attempt_id=? AND i.predecessor_task_id=? AND a.goal_id=? AND a.task_id=? AND a.attempt_id=?`)
      .all(attemptId, String(dep.predecessor_task_id), goalId, String(dep.predecessor_task_id), evidence.attemptId);
    if (inputs.length !== evidence.artifacts.length) return false;
    for (const artifact of evidence.artifacts) {
      const input = inputs.find(item => item.artifact_id === artifact.id);
      if (!input || input.sha256 !== artifact.sha256 || input.snapshot_sha !== artifact.sha256 || Number(input.bytes) !== artifact.bytes ||
        Number(input.snapshot_bytes) !== artifact.bytes || input.logical_name !== artifact.logicalName) return false;
      const latest = db.prepare("SELECT MAX(revision) AS revision FROM goal_artifacts WHERE task_id=? AND logical_name=?")
        .get(String(dep.predecessor_task_id), artifact.logicalName);
      if (latest?.revision !== input.revision) return false;
    }
  }
  return true;
}

export function readInputSnapshot(db: DatabaseSync, attemptId: string, artifactId: string, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw new Error("invalid input range");
  const row = db.prepare(`SELECT i.logical_name, i.sha256, i.bytes, s.contents FROM goal_attempt_inputs i
    JOIN goal_artifact_snapshots s ON s.artifact_id=i.artifact_id AND s.sha256=i.sha256 AND s.bytes=i.bytes
    WHERE i.attempt_id=? AND i.artifact_id=?`).get(attemptId, artifactId);
  if (!row) throw new Error("input artifact is not authorized for this attempt");
  const contents = Buffer.from(row.contents as Uint8Array);
  if (contents.length !== Number(row.bytes) || createHash("sha256").update(contents).digest("hex") !== row.sha256) throw new Error("input snapshot is corrupted");
  if (offset > contents.length) throw new Error("input offset out of bounds");
  const chunk = contents.subarray(offset, offset + length);
  return { logicalName: String(row.logical_name), sha256: String(row.sha256), bytes: contents.length, offset,
    dataBase64: chunk.toString("base64"), nextOffset: offset + chunk.length, complete: offset + chunk.length === contents.length };
}
