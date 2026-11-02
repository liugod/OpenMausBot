import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { taskInputsCurrent } from "./task-inputs.ts";

const taskSchema = z.object({ criteria: z.array(z.object({ id: z.string(), required: z.boolean(), kind: z.string(), config: z.record(z.string(), z.unknown()) })) });
const resultSchema = z.object({ artifactIds: z.array(z.string()) });
const key = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export type AutomaticAction =
  | { kind: "check"; goalId: string; ownerId: string; taskId: string; criterionId: string; artifactId: string; checkId: string; commandId: string; expectedVersion: number }
  | { kind: "block"; goalId: string; ownerId: string; taskId: string; code: "missing_artifact" | "check_failed" | "check_unknown" | "stale_inputs"; expectedVersion: number }
  | { kind: "finalize"; goalId: string; ownerId: string; taskId: string; reviewAttemptId: string; commandId: string; expectedVersion: number };

export function automaticActionForTask(db: DatabaseSync, goalId: string, taskId: string): AutomaticAction | undefined {
  const row = db.prepare(`SELECT g.owner_id, g.version, g.requirement_revision, g.plan_revision, t.task_json
    FROM goals g JOIN goal_tasks t ON t.goal_id=g.id AND t.plan_revision=g.plan_revision
    JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
    JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
    WHERE g.id=? AND t.id=? AND g.status='active' AND t.status='checking' AND w.status='active' AND a.status='active'`).get(goalId, taskId);
  if (!row) return undefined;
  const base = { goalId, ownerId: String(row.owner_id), taskId, expectedVersion: Number(row.version) };
  const attempt = db.prepare("SELECT id, status FROM goal_attempts WHERE goal_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(goalId, taskId);
  if (!attempt || attempt.status !== "succeeded") return undefined;
  const review = db.prepare("SELECT id, status FROM goal_review_attempts WHERE goal_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(goalId, taskId);
  if (review && ["prepared", "queued", "running", "waiting", "reconciling"].includes(String(review.status))) return undefined;
  if (!taskInputsCurrent(db, goalId, String(attempt.id))) return { ...base, kind: "block", code: "stale_inputs" };
  if (review?.status === "succeeded") return { ...base, kind: "finalize", reviewAttemptId: String(review.id), commandId: `auto-finalize:${key([String(review.id)])}` };
  const result = db.prepare("SELECT result_json FROM goal_task_results WHERE attempt_id=? AND requirement_revision=? AND plan_revision=?")
    .get(String(attempt.id), Number(row.requirement_revision), Number(row.plan_revision));
  if (!result) return undefined;
  const ids = resultSchema.parse(JSON.parse(String(result.result_json))).artifactIds;
  const task = taskSchema.parse(JSON.parse(String(row.task_json)));
  for (const criterion of task.criteria.filter(item => item.required)) {
    if (criterion.kind === "lead_review") continue;
    if (!["artifact_exists", "json_schema"].includes(criterion.kind)) return undefined;
    const artifact = ids.map(id => db.prepare("SELECT id, logical_name, sha256, revision FROM goal_artifacts WHERE id=? AND goal_id=? AND task_id=? AND attempt_id=?")
      .get(id, goalId, taskId, String(attempt.id))).filter(item => item?.logical_name === criterion.config.logicalName)
      .sort((a, b) => Number(b!.revision) - Number(a!.revision))[0];
    if (!artifact) return { ...base, kind: "block", code: "missing_artifact" };
    const latest = db.prepare("SELECT MAX(revision) AS revision FROM goal_artifacts WHERE task_id=? AND logical_name=?").get(taskId, String(artifact.logical_name));
    if (Number(latest?.revision) !== Number(artifact.revision)) return { ...base, kind: "block", code: "check_unknown" };
    const check = db.prepare(`SELECT verdict, artifact_id, artifact_sha256 FROM goal_check_runs WHERE goal_id=? AND task_id=? AND criterion_id=?
      AND requirement_revision=? ORDER BY rowid DESC LIMIT 1`).get(goalId, taskId, criterion.id, Number(row.requirement_revision));
    if (!check || check.artifact_id !== artifact.id || check.artifact_sha256 !== artifact.sha256) {
      const digest = key([String(attempt.id), criterion.id, String(artifact.id), String(artifact.sha256)]);
      return { ...base, kind: "check", criterionId: criterion.id, artifactId: String(artifact.id), checkId: `check:${digest}`, commandId: `auto-check:${digest}` };
    }
    if (check.verdict !== "pass") return { ...base, kind: "block", code: check.verdict === "fail" ? "check_failed" : "check_unknown" };
  }
  return undefined;
}

export function nextAutomaticAction(db: DatabaseSync, afterGoalId: string, afterTaskId: string, limit: number) {
  const rows = db.prepare(`SELECT g.id AS goal_id, t.id AS task_id FROM goals g JOIN goal_tasks t ON t.goal_id=g.id AND t.plan_revision=g.plan_revision
    WHERE g.status='active' AND t.status='checking' AND (g.id>? OR (g.id=? AND t.id>?)) ORDER BY g.id, t.id LIMIT ?`)
    .all(afterGoalId, afterGoalId, afterTaskId, limit);
  for (const row of rows) {
    const action = automaticActionForTask(db, String(row.goal_id), String(row.task_id));
    if (action) return { action, cursor: { goalId: String(row.goal_id), taskId: String(row.task_id) } };
  }
  const last = rows.at(-1);
  return { action: undefined, cursor: last ? { goalId: String(last.goal_id), taskId: String(last.task_id) } : undefined };
}
