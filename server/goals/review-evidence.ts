import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { taskInputsCurrent } from "./task-inputs.ts";

const criterion = z.object({ id: z.string().min(1), description: z.string().min(1), required: z.boolean(),
  kind: z.enum(["artifact_exists", "json_schema", "command_exit", "lead_review"]), config: z.record(z.string(), z.unknown()) });
const taskSchema = z.object({ id: z.string().min(1), workspaceRef: z.string().min(1), criteria: z.array(criterion) });
const resultSchema = z.object({ artifactIds: z.array(z.string()) });

export function reviewEvidence(db: DatabaseSync, goalId: string, taskId: string) {
  const row = db.prepare(`SELECT g.requirement_revision, g.plan_revision, t.status, t.plan_revision AS task_plan, t.task_json
    FROM goals g JOIN goal_tasks t ON t.goal_id=g.id WHERE g.id=? AND t.id=?`).get(goalId, taskId);
  if (!row || row.status !== "checking" || row.plan_revision !== row.task_plan) throw new Error("task is not ready for review");
  const task = taskSchema.parse(JSON.parse(String(row.task_json)));
  const attempt = db.prepare(`SELECT id, status FROM goal_attempts WHERE goal_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(goalId, taskId);
  if (!attempt || attempt.status !== "succeeded") throw new Error("work attempt has not succeeded");
  if (!taskInputsCurrent(db, goalId, String(attempt.id))) throw new Error("work inputs are stale");
  const result = db.prepare(`SELECT result_json FROM goal_task_results WHERE attempt_id=? AND goal_id=? AND task_id=?
    AND requirement_revision=? AND plan_revision=?`).get(String(attempt.id), goalId, taskId, Number(row.requirement_revision), Number(row.plan_revision));
  if (!result) throw new Error("current structured task result is missing");
  const resultArtifactIds = new Set(resultSchema.parse(JSON.parse(String(result.result_json))).artifactIds);
  const artifacts: { id: string; logicalName: string; reference: string; sha256: string; bytes: number; revision: number }[] = [];
  for (const artifactId of resultArtifactIds) {
    const artifact = db.prepare(`SELECT id, logical_name, reference, sha256, bytes, revision, requirement_revision FROM goal_artifacts
      WHERE id=? AND goal_id=? AND task_id=? AND attempt_id=?`).get(artifactId, goalId, taskId, String(attempt.id));
    if (!artifact || Number(artifact.requirement_revision) !== Number(row.requirement_revision)) throw new Error("result artifact is stale");
    const latest = db.prepare("SELECT MAX(revision) AS revision FROM goal_artifacts WHERE task_id=? AND logical_name=?").get(taskId, String(artifact.logical_name));
    if (Number(latest?.revision) !== Number(artifact.revision)) throw new Error("result artifact has been superseded");
    artifacts.push({ id: String(artifact.id), logicalName: String(artifact.logical_name), reference: String(artifact.reference),
      sha256: String(artifact.sha256), bytes: Number(artifact.bytes), revision: Number(artifact.revision) });
  }
  artifacts.sort((a, b) => a.id.localeCompare(b.id));
  const checks: { criterionId: string; checkId: string; artifactId: string; sha256: string }[] = [];
  for (const item of task.criteria.filter(c => c.required)) {
    if (item.kind === "lead_review") continue;
    if (item.kind === "command_exit") throw new Error("controlled command checks are not available");
    const check = db.prepare(`SELECT id, artifact_id, artifact_sha256, verdict FROM goal_check_runs WHERE goal_id=? AND task_id=?
      AND criterion_id=? AND requirement_revision=? ORDER BY rowid DESC LIMIT 1`).get(goalId, taskId, item.id, Number(row.requirement_revision));
    const artifact = artifacts.find(a => a.id === check?.artifact_id && a.logicalName === item.config.logicalName && a.sha256 === check?.artifact_sha256);
    if (!check || check.verdict !== "pass" || !artifact) throw new Error("required check is not current and passing");
    checks.push({ criterionId: item.id, checkId: String(check.id), artifactId: artifact.id, sha256: artifact.sha256 });
  }
  checks.sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  return { requirementRevision: Number(row.requirement_revision), planRevision: Number(row.plan_revision), attemptId: String(attempt.id),
    workspaceRef: task.workspaceRef, criteria: task.criteria, artifacts, checks };
}
