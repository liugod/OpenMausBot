import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseDispatchIntent, type DispatchIntent } from "./execution-budget.ts";
import type { Assignment } from "../runtime/types.ts";
import { captureArtifact, checkArtifact, checkJsonSchema, inspectArtifact } from "./artifacts.ts";
import { assignDefaultScope, bindWorkThread, createWorkScopeApi, goalScopeActive, migrateWorkScopes } from "./work-scopes.ts";
import { reviewEvidence } from "./review-evidence.ts";
import { bindTaskInputs, readInputSnapshot, taskInputsCurrent } from "./task-inputs.ts";
import { automaticActionForTask, nextAutomaticAction } from "./automatic-work.ts";

const artifactConfigSchema = z.strictObject({ logicalName: z.string().min(1), minBytes: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().nonnegative().optional(), mediaTypes: z.array(z.string().min(1)).min(1).max(20).optional(),
  extensions: z.array(z.string().regex(/^\.[a-zA-Z0-9]{1,16}$/)).min(1).max(20).optional() })
  .refine(c => c.minBytes === undefined || c.maxBytes === undefined || c.minBytes <= c.maxBytes);
const jsonConfigSchema = z.strictObject({ logicalName: z.string().min(1), schema: z.record(z.string(), z.unknown()) })
  .refine(c => { try { return JSON.stringify(c.schema).length <= 64_000; } catch { return false; } });
const criterionSchema = z.object({ id: z.string().min(1), description: z.string().min(1), required: z.boolean(),
  kind: z.enum(["artifact_exists", "json_schema", "command_exit", "lead_review"]), config: z.record(z.string(), z.unknown()) })
  .refine(c => c.kind !== "artifact_exists" || artifactConfigSchema.safeParse(c.config).success,
    { message: "artifact_exists requires a valid file constraint" })
  .refine(c => c.kind !== "json_schema" || jsonConfigSchema.safeParse(c.config).success,
    { message: "json_schema requires a bounded schema and logicalName" });
const taskSchema = z.object({ id: z.string().min(1), title: z.string().min(1), brief: z.string().min(1),
  assigneeBotId: z.string().min(1), required: z.boolean(), workspaceRef: z.string().min(1),
  criteria: z.array(criterionSchema).min(1).max(200), dependsOn: z.array(z.string().min(1)).max(199) });
const planSchema = z.object({ goalId: z.string().min(1), ownerId: z.string().min(1), commandId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(), requirementRevision: z.number().int().positive(),
  sourceAttemptId: z.string().min(1), reason: z.string().min(1), tasks: z.array(taskSchema).min(1).max(200) });
const createSchema = z.object({ id: z.string().min(1), ownerId: z.string().min(1), commandId: z.string().min(1),
  title: z.string().min(1), request: z.string().min(1), leadBotId: z.string().min(1), leadThreadId: z.string().min(1),
  executionLimit: z.number().int().nonnegative(), workstreamId: z.string().min(1).optional(), budgetPeriod: z.string().min(1).optional() });
const standaloneSchema = z.strictObject({ containerId: z.string().min(1), ownerId: z.string().min(1), commandId: z.string().min(1),
  workstreamId: z.string().min(1), leadThreadId: z.string().min(1), executionLimit: z.number().int().nonnegative().safe(),
  task: taskSchema, sourceThreadId: z.string().min(1).max(200).optional(), budgetPeriod: z.string().min(1).optional(), routineId: z.string().min(1).optional(), occurrenceKey: z.string().min(1).optional() })
  .refine(v => Boolean(v.routineId) === Boolean(v.occurrenceKey), "routine and occurrence must be specified together")
  .refine(v => v.task.dependsOn.length === 0, "standalone task cannot have dependencies");
const artifactSchema = z.object({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
  taskId: z.string().min(1), attemptId: z.string().min(1), artifactId: z.string().min(1), logicalName: z.string().min(1),
  reference: z.string().min(1), expectedVersion: z.number().int().nonnegative() });
const artifactCheckSchema = z.object({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
  taskId: z.string().min(1), criterionId: z.string().min(1), artifactId: z.string().min(1), checkId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative() });
const resultSchema = z.strictObject({ commandId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
  requirementRevision: z.number().int().positive(), planRevision: z.number().int().positive(), artifactIds: z.array(z.string().min(1)).max(200),
  claims: z.array(z.strictObject({ criterionId: z.string().min(1), verdict: z.enum(["met", "not_met", "unknown"]), note: z.string().min(1).max(4000) })).max(200),
  knownIssues: z.array(z.string().max(4000)).max(50) });
const reviewResultSchema = z.strictObject({ commandId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
  verdicts: z.array(z.strictObject({ criterionId: z.string().min(1), verdict: z.enum(["pass", "fail", "unknown"]),
    reason: z.string().trim().min(1).max(4000) })).min(1).max(200) });

export type GoalCreate = z.infer<typeof createSchema>;
export type GoalPlan = z.infer<typeof planSchema>;
export const parseGoalPlan = (input: unknown): GoalPlan => planSchema.parse(input);
export interface GoalRunContext {
  rootId: string;
  botId: string;
  threadId: string;
  executionNo: number;
}

function assertDag(tasks: GoalPlan["tasks"]): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("duplicate task id");
  const states = new Map<string, number>();
  function visit(id: string): void {
    if (states.get(id) === 1) throw new Error("cyclic dependencies");
    if (states.get(id) === 2) return;
    const task = byId.get(id);
    if (!task) throw new Error("unknown dependency");
    states.set(id, 1);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error("duplicate dependency");
    if (new Set(task.criteria.map(c => c.id)).size !== task.criteria.length) throw new Error("duplicate criterion id");
    for (const dep of task.dependsOn) visit(dep);
    states.set(id, 2);
  }
  for (const task of tasks) visit(task.id);
}

export function openGoalStore(path: string, options: { unsafeTestPlanBootstrap?: boolean } = {}) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    try { chmodSync(path, 0o600); } catch {}
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const metadataExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_schema_migrations'").get();
  const currentSchema = metadataExists ? Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM goal_schema_migrations").get()?.version) : 0;
  if (currentSchema > 9) { db.close(); throw new Error("goals.db schema is newer than this build"); }
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS goal_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
    CREATE TABLE IF NOT EXISTS goal_execution_budgets (goal_id TEXT PRIMARY KEY, execution_limit INTEGER NOT NULL CHECK(execution_limit >= 0));
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, original_request TEXT NOT NULL,
      lead_bot_id TEXT NOT NULL, lead_thread_id TEXT NOT NULL, status TEXT NOT NULL, requirement_revision INTEGER NOT NULL,
      plan_revision INTEGER NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_plans (goal_id TEXT NOT NULL REFERENCES goals(id), revision INTEGER NOT NULL,
      requirement_revision INTEGER NOT NULL, source_attempt_id TEXT NOT NULL, plan_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(goal_id, revision));
    CREATE TABLE IF NOT EXISTS goal_tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), plan_revision INTEGER NOT NULL,
      status TEXT NOT NULL, task_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_dependencies (goal_id TEXT NOT NULL REFERENCES goals(id), task_id TEXT NOT NULL REFERENCES goal_tasks(id),
      depends_on_id TEXT NOT NULL REFERENCES goal_tasks(id), PRIMARY KEY(goal_id, task_id, depends_on_id), CHECK(task_id <> depends_on_id));
    CREATE TABLE IF NOT EXISTS goal_commands (owner_id TEXT NOT NULL, command_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, PRIMARY KEY(owner_id, command_id));
    CREATE TABLE IF NOT EXISTS goal_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES goals(id),
      kind TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_execution_roots (root_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goal_execution_budgets(goal_id));
    CREATE TABLE IF NOT EXISTS goal_dispatch_outbox (dispatch_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, root_id TEXT NOT NULL UNIQUE,
      goal_id TEXT NOT NULL REFERENCES goal_execution_budgets(goal_id), request_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending', 'accepted')));
    CREATE TABLE IF NOT EXISTS goal_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      task_id TEXT NOT NULL REFERENCES goal_tasks(id), root_id TEXT NOT NULL UNIQUE, workspace_ref TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, last_event_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS goal_management_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      kind TEXT NOT NULL CHECK(kind IN ('plan')), root_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      requirement_revision INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_event_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS goal_inbox (source TEXT NOT NULL, source_event_id INTEGER NOT NULL, root_id TEXT NOT NULL,
      PRIMARY KEY(source, source_event_id));
    CREATE TABLE IF NOT EXISTS goal_scheduler_cursor (source TEXT PRIMARY KEY, seq INTEGER NOT NULL CHECK(seq >= 0));
    INSERT OR IGNORE INTO goal_scheduler_cursor VALUES ('runtime', 0);
    CREATE TABLE IF NOT EXISTS goal_pause_state (goal_id TEXT PRIMARY KEY REFERENCES goals(id), previous_status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_stop_outbox (root_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      attempt_id TEXT NOT NULL REFERENCES goal_attempts(id), dispatch_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed')));
    CREATE TABLE IF NOT EXISTS goal_management_stop_outbox (root_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      attempt_id TEXT NOT NULL REFERENCES goal_management_attempts(id), dispatch_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed')));
    CREATE TABLE IF NOT EXISTS goal_artifacts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      task_id TEXT NOT NULL REFERENCES goal_tasks(id), attempt_id TEXT NOT NULL REFERENCES goal_attempts(id),
      logical_name TEXT NOT NULL, revision INTEGER NOT NULL, reference TEXT NOT NULL, sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL, media_type TEXT NOT NULL, requirement_revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(task_id, logical_name, revision));
    CREATE TABLE IF NOT EXISTS goal_check_runs (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      task_id TEXT NOT NULL REFERENCES goal_tasks(id), criterion_id TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES goal_artifacts(id),
      artifact_sha256 TEXT NOT NULL, requirement_revision INTEGER NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','unknown')),
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_task_results (attempt_id TEXT PRIMARY KEY REFERENCES goal_attempts(id),
      goal_id TEXT NOT NULL REFERENCES goals(id), task_id TEXT NOT NULL REFERENCES goal_tasks(id), requirement_revision INTEGER NOT NULL,
      plan_revision INTEGER NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_task_blockers (task_id TEXT PRIMARY KEY REFERENCES goal_tasks(id), code TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_review_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      task_id TEXT NOT NULL REFERENCES goal_tasks(id), root_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_event_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS goal_review_results (attempt_id TEXT PRIMARY KEY REFERENCES goal_review_attempts(id), result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_review_stop_outbox (root_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      attempt_id TEXT NOT NULL REFERENCES goal_review_attempts(id), dispatch_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed')));
    CREATE TABLE IF NOT EXISTS goal_artifact_snapshots (artifact_id TEXT PRIMARY KEY REFERENCES goal_artifacts(id),
      sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), contents BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_attempt_dependencies (attempt_id TEXT NOT NULL REFERENCES goal_attempts(id),
      predecessor_task_id TEXT NOT NULL REFERENCES goal_tasks(id), review_attempt_id TEXT NOT NULL REFERENCES goal_review_attempts(id),
      requirement_revision INTEGER NOT NULL, plan_revision INTEGER NOT NULL, PRIMARY KEY(attempt_id, predecessor_task_id));
    CREATE TABLE IF NOT EXISTS goal_attempt_inputs (attempt_id TEXT NOT NULL REFERENCES goal_attempts(id),
      predecessor_task_id TEXT NOT NULL REFERENCES goal_tasks(id), artifact_id TEXT NOT NULL REFERENCES goal_artifact_snapshots(artifact_id),
      logical_name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(attempt_id, artifact_id));
    INSERT OR IGNORE INTO goal_pause_state (goal_id, previous_status)
      SELECT id, CASE WHEN plan_revision=0 THEN 'planning' ELSE 'active' END FROM goals WHERE status='paused';
    `);
    const requiredColumns: Record<string, string[]> = {
      goals: ["id", "owner_id", "title", "original_request", "lead_bot_id", "lead_thread_id", "status", "requirement_revision", "plan_revision", "version", "created_at"],
      goal_attempts: ["id", "goal_id", "task_id", "root_id", "workspace_ref", "status", "created_at", "last_event_id"],
      goal_management_attempts: ["id", "goal_id", "kind", "root_id", "bot_id", "thread_id", "requirement_revision", "status", "created_at", "last_event_id"],
      goal_dispatch_outbox: ["dispatch_key", "attempt_id", "root_id", "goal_id", "request_json", "state"],
      goal_execution_budgets: ["goal_id", "execution_limit"],
      goal_tasks: ["id", "goal_id", "plan_revision", "status", "task_json"],
      goal_task_results: ["attempt_id", "goal_id", "task_id", "requirement_revision", "plan_revision", "result_json", "created_at"],
      goal_review_attempts: ["id", "goal_id", "task_id", "root_id", "bot_id", "thread_id", "evidence_json", "status", "created_at", "last_event_id"],
      goal_review_results: ["attempt_id", "result_json", "created_at"],
      goal_review_stop_outbox: ["root_id", "goal_id", "attempt_id", "dispatch_key", "state"],
      goal_artifact_snapshots: ["artifact_id", "sha256", "bytes", "contents", "created_at"],
      goal_attempt_dependencies: ["attempt_id", "predecessor_task_id", "review_attempt_id", "requirement_revision", "plan_revision"],
      goal_attempt_inputs: ["attempt_id", "predecessor_task_id", "artifact_id", "logical_name", "sha256", "bytes"],
    };
    for (const [table, required] of Object.entries(requiredColumns)) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
      if (!required.every(name => columns.has(name))) throw new Error(`goals.db contains an unsupported ${table} schema`);
    }
    migrateWorkScopes(db);
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (1, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (2, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (3, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (4, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (5, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (6, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (7, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (8, ?)").run(Date.now());
    db.prepare("INSERT OR IGNORE INTO goal_schema_migrations (version, applied_at) VALUES (9, ?)").run(Date.now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const command = db.prepare("SELECT request_hash, result_json FROM goal_commands WHERE owner_id=? AND command_id=?");
  const saveCommand = db.prepare("INSERT INTO goal_commands VALUES (?, ?, ?, ?)");
  const getGoal = db.prepare("SELECT * FROM goals WHERE id=? AND owner_id=?");
  const addGoal = db.prepare("INSERT INTO goals VALUES (?, ?, ?, ?, ?, ?, 'planning', 1, 0, 1, ?)");
  const addBudget = db.prepare("INSERT INTO goal_execution_budgets VALUES (?, ?)");
  const addPlan = db.prepare("INSERT INTO goal_plans VALUES (?, ?, ?, ?, ?, ?)");
  const addTask = db.prepare("INSERT INTO goal_tasks VALUES (?, ?, ?, 'planned', ?)");
  const addDependency = db.prepare("INSERT INTO goal_dependencies VALUES (?, ?, ?)");
  const saveGoal = db.prepare("UPDATE goals SET status=?, plan_revision=?, version=? WHERE id=?");
  const addEvent = db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) VALUES (?, ?, ?, ?)");
  const readTasks = db.prepare("SELECT task_json, status FROM goal_tasks WHERE goal_id=? ORDER BY rowid");
  const readTask = db.prepare("SELECT task_json, status, plan_revision FROM goal_tasks WHERE id=? AND goal_id=?");
  const unfinishedDependencies = db.prepare(`SELECT COUNT(*) AS n FROM goal_dependencies d JOIN goal_tasks p ON p.id=d.depends_on_id
    WHERE d.goal_id=? AND d.task_id=? AND p.status <> 'succeeded'`);
  const activeTask = db.prepare("SELECT 1 FROM goal_attempts WHERE task_id=? AND status IN ('prepared','queued','running','waiting','reconciling')");
  const activeWorkspace = db.prepare("SELECT 1 FROM goal_attempts WHERE workspace_ref=? AND status IN ('prepared','queued','running','waiting','reconciling')");
  const activeGoalCount = db.prepare(`SELECT (SELECT COUNT(*) FROM goal_attempts WHERE goal_id=? AND status IN ('prepared','queued','running','waiting','reconciling'))
    + (SELECT COUNT(*) FROM goal_review_attempts WHERE goal_id=?1 AND status IN ('prepared','queued','running','waiting','reconciling')) AS n`);
  const activeGoals = db.prepare(`SELECT COUNT(DISTINCT goal_id) AS n FROM (
    SELECT goal_id FROM goal_attempts WHERE status IN ('prepared','queued','running','waiting','reconciling')
    UNION ALL SELECT goal_id FROM goal_management_attempts WHERE status IN ('prepared','queued','running','waiting','reconciling')
    UNION ALL SELECT goal_id FROM goal_review_attempts WHERE status IN ('prepared','queued','running','waiting','reconciling'))`);
  const attemptCount = db.prepare("SELECT COUNT(*) AS n FROM goal_attempts WHERE goal_id=?");
  const insertRoot = db.prepare("INSERT INTO goal_execution_roots VALUES (?, ?)");
  const insertAttempt = db.prepare("INSERT INTO goal_attempts (id, goal_id, task_id, root_id, workspace_ref, status, created_at) VALUES (?, ?, ?, ?, ?, 'prepared', ?)");
  const insertManager = db.prepare("INSERT INTO goal_management_attempts (id, goal_id, kind, root_id, bot_id, thread_id, requirement_revision, status, created_at) VALUES (?, ?, 'plan', ?, ?, ?, ?, 'prepared', ?)");
  const insertOutbox = db.prepare("INSERT INTO goal_dispatch_outbox VALUES (?, ?, ?, ?, ?, 'pending')");
  const readyTask = db.prepare("UPDATE goal_tasks SET status='ready' WHERE id=? AND goal_id=?");
  const setVersion = db.prepare("UPDATE goals SET version=? WHERE id=?");
  const taskAttempt = db.prepare("SELECT status FROM goal_attempts WHERE id=? AND task_id=? AND goal_id=?");
  const artifactRevision = db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM goal_artifacts WHERE task_id=? AND logical_name=?");
  const insertArtifact = db.prepare("INSERT INTO goal_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const readArtifacts = db.prepare("SELECT id, task_id, attempt_id, logical_name, revision, reference, sha256, bytes, media_type FROM goal_artifacts WHERE goal_id=? ORDER BY rowid");
  const readArtifact = db.prepare("SELECT * FROM goal_artifacts WHERE id=? AND task_id=? AND goal_id=?");
  const insertCheck = db.prepare("INSERT INTO goal_check_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const readChecks = db.prepare("SELECT id, task_id, criterion_id, artifact_id, artifact_sha256, verdict FROM goal_check_runs WHERE goal_id=? ORDER BY rowid");
  function execute<T extends { ownerId: string; commandId: string }, R extends { goalId: string; version: number }>(kind: string, input: T, fn: () => R): R {
    const hash = createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = command.get(input.ownerId, input.commandId);
      if (existing) {
        if (existing.request_hash !== hash) throw new Error("command id conflict");
        const result = JSON.parse(String(existing.result_json)) as R;
        db.exec("COMMIT");
        return result;
      }
      const result = fn();
      saveCommand.run(input.ownerId, input.commandId, hash, JSON.stringify(result));
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function writeInitialPlan(value: GoalPlan, version: number, status: "active" | "planning" | "paused") {
    const now = Date.now();
    addPlan.run(value.goalId, 1, value.requirementRevision, value.sourceAttemptId, JSON.stringify(value), now);
    for (const task of value.tasks) addTask.run(task.id, value.goalId, 1, JSON.stringify(task));
    for (const task of value.tasks) for (const dep of task.dependsOn) addDependency.run(value.goalId, task.id, dep);
    saveGoal.run(status, 1, version, value.goalId);
    addEvent.run(value.goalId, "plan_submitted", version, now);
    return { goalId: value.goalId, version };
  }
  function workContext(context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean) {
    const bound = z.object({ rootId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
      executionNo: z.number().int().positive() }).parse(context);
    const row = db.prepare(`SELECT a.id AS attempt_id, a.status AS attempt_status, t.id AS task_id, t.status AS task_status,
      t.task_json, t.plan_revision AS task_plan, g.id AS goal_id, g.owner_id, g.title, g.original_request, g.status AS goal_status,
      g.requirement_revision, g.plan_revision, g.version, o.request_json, w.id AS workstream_id, w.area_id,
      CASE WHEN c.goal_id IS NULL THEN 0 ELSE 1 END AS standalone
      FROM goal_attempts a JOIN goals g ON g.id=a.goal_id JOIN goal_tasks t ON t.id=a.task_id AND t.goal_id=g.id
      JOIN goal_dispatch_outbox o ON o.attempt_id=a.id JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id
      JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
      LEFT JOIN work_execution_containers c ON c.goal_id=g.id AND c.owner_id=g.owner_id AND c.workstream_id=w.id WHERE a.root_id=?`).get(bound.rootId);
    const pause = row?.goal_status === "paused" ? db.prepare("SELECT previous_status FROM goal_pause_state WHERE goal_id=?").get(String(row.goal_id)) : undefined;
    if (!row || !(row.goal_status === "active" || (row.goal_status === "paused" && pause?.previous_status === "active")) ||
      !["queued", "running", "waiting"].includes(String(row.attempt_status)) || !["ready", "running", "waiting_user"].includes(String(row.task_status)) ||
      Number(row.task_plan) !== Number(row.plan_revision) || isCurrentRun(bound) !== true || !taskInputsCurrent(db, String(row.goal_id), String(row.attempt_id))) throw new Error("work run is not authorized or current");
    const intent = parseDispatchIntent(JSON.parse(String(row.request_json)));
    const task = taskSchema.parse(JSON.parse(String(row.task_json)));
    if (intent.request.rootId !== bound.rootId || intent.request.assignee.botId !== bound.botId ||
      intent.request.assignee.destination.threadId !== bound.threadId || task.assigneeBotId !== bound.botId) throw new Error("work run identity does not match task");
    return { goalId: String(row.goal_id), ownerId: String(row.owner_id), attemptId: String(row.attempt_id), taskId: String(row.task_id),
      title: String(row.title), request: String(row.original_request), requirementRevision: Number(row.requirement_revision),
      planRevision: Number(row.plan_revision), version: Number(row.version), areaId: String(row.area_id), workstreamId: String(row.workstream_id),
      standalone: Boolean(row.standalone), task };
  }
  function reviewContext(context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean) {
    const bound = z.object({ rootId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
      executionNo: z.number().int().positive() }).parse(context);
    const row = db.prepare(`SELECT r.*, g.owner_id, g.status AS goal_status, g.version, w.id AS workstream_id, w.area_id,
      CASE WHEN c.goal_id IS NULL THEN 0 ELSE 1 END AS standalone FROM goal_review_attempts r
      JOIN goals g ON g.id=r.goal_id JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id
      JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
      LEFT JOIN work_execution_containers c ON c.goal_id=g.id WHERE r.root_id=? AND r.bot_id=? AND r.thread_id=?`)
      .get(bound.rootId, bound.botId, bound.threadId);
    if (!row || !["active", "paused"].includes(String(row.goal_status)) || !["queued", "running"].includes(String(row.status)) ||
      isCurrentRun(bound) !== true) throw new Error("review run is not authorized or current");
    const evidence = reviewEvidence(db, String(row.goal_id), String(row.task_id));
    if (JSON.stringify(evidence) !== row.evidence_json) throw new Error("review evidence is stale");
    return { goalId: String(row.goal_id), ownerId: String(row.owner_id), attemptId: String(row.id), taskId: String(row.task_id),
      version: Number(row.version), areaId: String(row.area_id), workstreamId: String(row.workstream_id), standalone: Boolean(row.standalone), evidence };
  }
  function refreshGoalState(goalId: string): void {
    const goal = db.prepare("SELECT status, plan_revision FROM goals WHERE id=?").get(goalId);
    if (!goal || !["active", "waiting_user", "blocked"].includes(String(goal.status)) || Number(goal.plan_revision) === 0) return;
    const tasks = db.prepare("SELECT id, status FROM goal_tasks WHERE goal_id=? AND plan_revision=?").all(goalId, Number(goal.plan_revision));
    const ready = tasks.some(task => task.status === "planned" && Number(unfinishedDependencies.get(goalId, String(task.id))?.n) === 0);
    const progressing = ready || tasks.some(task => ["ready", "running", "checking"].includes(String(task.status)));
    const blocked = tasks.some(task => task.status === "blocked");
    const waiting = tasks.some(task => task.status === "waiting_user");
    const allSucceeded = tasks.length > 0 && tasks.every(task => task.status === "succeeded");
    const status = progressing || allSucceeded ? "active" : blocked ? "blocked" : waiting ? "waiting_user" : "blocked";
    db.prepare("UPDATE goals SET status=? WHERE id=?").run(status, goalId);
  }
  return {
    scopes: createWorkScopeApi(db),
    createStandalone(input: z.input<typeof standaloneSchema>) {
      const value = standaloneSchema.parse(input);
      const fingerprint = createHash("sha256").update(JSON.stringify({ ownerId: value.ownerId, workstreamId: value.workstreamId,
        task: { ...value.task, id: undefined }, leadThreadId: value.leadThreadId, executionLimit: value.executionLimit,
        budgetPeriod: value.budgetPeriod, routineId: value.routineId, occurrenceKey: value.occurrenceKey,
        ...(value.sourceThreadId ? { sourceThreadId: value.sourceThreadId } : {}) })).digest("hex");
      return execute("create-standalone", value, () => {
        if (value.routineId && value.occurrenceKey) {
          const old = db.prepare(`SELECT c.goal_id, c.owner_id, c.request_hash, g.version FROM work_execution_containers c
            JOIN goals g ON g.id=c.goal_id WHERE c.workstream_id=? AND c.routine_id=? AND c.occurrence_key=?`)
            .get(value.workstreamId, value.routineId, value.occurrenceKey);
          if (old) {
            if (old.owner_id !== value.ownerId || old.request_hash !== fingerprint) throw new Error("occurrence key conflict");
            return { goalId: String(old.goal_id), version: Number(old.version) };
          }
        }
        const scope = db.prepare(`SELECT w.kind FROM work_streams w JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
          WHERE w.id=? AND w.owner_id=? AND w.status='active' AND a.status='active'`).get(value.workstreamId, value.ownerId);
        if (!scope) throw new Error("active workstream not found");
        if (!db.prepare("SELECT 1 FROM work_global_budgets WHERE owner_id=?").get(value.ownerId)) throw new Error("global execution budget required");
        if (scope.kind === "ongoing" && (!value.budgetPeriod || !db.prepare("SELECT 1 FROM work_period_budgets WHERE workstream_id=? AND period_key=?")
          .get(value.workstreamId, value.budgetPeriod))) throw new Error("ongoing period budget required");
        const now = Date.now();
        addGoal.run(value.containerId, value.ownerId, value.task.title, value.task.brief, value.task.assigneeBotId, value.leadThreadId, now);
        addBudget.run(value.containerId, value.executionLimit);
        db.prepare("INSERT INTO goal_workstreams (goal_id, owner_id, workstream_id) VALUES (?, ?, ?)").run(value.containerId, value.ownerId, value.workstreamId);
        db.prepare(`INSERT INTO work_execution_containers (goal_id, owner_id, workstream_id, routine_id, occurrence_key, budget_period, request_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(value.containerId, value.ownerId, value.workstreamId, value.routineId ?? null,
          value.occurrenceKey ?? null, value.budgetPeriod ?? null, fingerprint);
        if (value.sourceThreadId) db.prepare("INSERT INTO work_chat_links (goal_id, owner_id, bot_id, thread_id) VALUES (?, ?, ?, ?)")
          .run(value.containerId, value.ownerId, value.task.assigneeBotId, value.sourceThreadId);
        if (scope.kind === "ongoing") db.prepare("INSERT INTO work_goal_budget_periods VALUES (?, ?, ?)")
          .run(value.containerId, value.workstreamId, value.budgetPeriod!);
        addEvent.run(value.containerId, "created", 1, now);
        return writeInitialPlan({ goalId: value.containerId, ownerId: value.ownerId, commandId: value.commandId, expectedVersion: 1,
          requirementRevision: 1, sourceAttemptId: `standalone:${value.containerId}`, reason: "standalone work item", tasks: [value.task] }, 2, "active");
      });
    },
    readStandalone(containerId: string, ownerId: string) {
      const row = db.prepare(`SELECT c.workstream_id, c.routine_id, c.occurrence_key, c.budget_period, g.status, g.version, t.id AS task_id, t.task_json, t.status AS task_status
        FROM work_execution_containers c JOIN goals g ON g.id=c.goal_id JOIN goal_tasks t ON t.goal_id=g.id
        WHERE c.goal_id=? AND c.owner_id=? AND g.owner_id=? AND t.plan_revision=g.plan_revision`).get(containerId, ownerId, ownerId);
      if (!row) return undefined;
      return { workstreamId: String(row.workstream_id), ...(row.routine_id === null ? {} : { routineId: String(row.routine_id), occurrenceKey: String(row.occurrence_key) }),
        ...(row.budget_period === null ? {} : { budgetPeriod: String(row.budget_period) }), status: String(row.status), version: Number(row.version),
        task: { ...taskSchema.parse(JSON.parse(String(row.task_json))), status: String(row.task_status) },
        artifacts: db.prepare(`SELECT a.id, a.logical_name AS logicalName, a.bytes, a.sha256 FROM goal_artifacts a
          JOIN goal_artifact_snapshots s ON s.artifact_id=a.id WHERE a.goal_id=? AND a.task_id=? ORDER BY a.logical_name, a.revision`).all(containerId, String(row.task_id)) };
    },
    create(input: GoalCreate) {
      const value = createSchema.parse(input);
      return execute("create", value, () => {
        const now = Date.now();
        addGoal.run(value.id, value.ownerId, value.title, value.request, value.leadBotId, value.leadThreadId, now);
        addBudget.run(value.id, value.executionLimit);
        if (value.workstreamId) {
          const active = db.prepare(`SELECT 1 FROM work_streams w JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
            WHERE w.id=? AND w.owner_id=? AND w.status='active' AND a.status='active'`).get(value.workstreamId, value.ownerId);
          if (!active) throw new Error("active workstream not found");
          db.prepare("INSERT INTO goal_workstreams (goal_id, owner_id, workstream_id) VALUES (?, ?, ?)").run(value.id, value.ownerId, value.workstreamId);
        } else assignDefaultScope(db, value.id, value.ownerId);
        if (value.budgetPeriod) {
          if (!value.workstreamId || !db.prepare("SELECT 1 FROM work_period_budgets WHERE workstream_id=? AND period_key=?").get(value.workstreamId, value.budgetPeriod)) throw new Error("configured workstream period budget required");
          db.prepare("INSERT INTO work_goal_budget_periods VALUES (?, ?, ?)").run(value.id, value.workstreamId, value.budgetPeriod);
        }
        addEvent.run(value.id, "created", 1, now);
        return { goalId: value.id, version: 1 };
      });
    },
    setPaused(input: { ownerId: string; commandId: string; goalId: string; expectedVersion: number; paused: boolean }) {
      const value = z.object({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
        expectedVersion: z.number().int().nonnegative(), paused: z.boolean() }).parse(input);
      return execute("set-paused", value, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        if (!goal || Number(goal.version) !== value.expectedVersion) throw new Error("goal not found or version conflict");
        if (value.paused && !["planning", "active", "waiting_user", "blocked"].includes(String(goal.status))) throw new Error("goal cannot be paused");
        if (!value.paused && goal.status !== "paused") throw new Error("goal is not paused");
        if (value.paused) db.prepare("INSERT INTO goal_pause_state (goal_id, previous_status) VALUES (?, ?)").run(value.goalId, String(goal.status));
        const previous = value.paused ? undefined : db.prepare("SELECT previous_status FROM goal_pause_state WHERE goal_id=?").get(value.goalId);
        if (!value.paused && !previous) throw new Error("paused goal has no stored prior state");
        const manager = value.paused ? undefined : db.prepare("SELECT status FROM goal_management_attempts WHERE goal_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(value.goalId);
        const managerStatus = manager ? String(manager.status) : undefined;
        const status = value.paused ? "paused" : previous?.previous_status === "blocked" ? "blocked"
          : managerStatus && ["failed", "cancelled", "reconciling"].includes(managerStatus) ? "blocked"
          : managerStatus === "waiting" ? "waiting_user"
            : managerStatus === "succeeded" && Number(goal.plan_revision) === 0 ? "blocked"
              : Number(goal.plan_revision) > 0 && (!managerStatus || managerStatus === "succeeded") ? "active" : "planning";
        const version = Number(goal.version) + 1;
        db.prepare("UPDATE goals SET status=?, version=? WHERE id=?").run(status, version, value.goalId);
        if (!value.paused) db.prepare("DELETE FROM goal_pause_state WHERE goal_id=?").run(value.goalId);
        if (!value.paused) refreshGoalState(value.goalId);
        addEvent.run(value.goalId, value.paused ? "paused" : "resumed", version, Date.now());
        return { goalId: value.goalId, version };
      });
    },
    cancel(input: { ownerId: string; commandId: string; goalId: string; expectedVersion: number }) {
      const value = z.object({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
        expectedVersion: z.number().int().nonnegative() }).parse(input);
      return execute("cancel", value, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        if (!goal || Number(goal.version) !== value.expectedVersion) throw new Error("goal not found or version conflict");
        if (["cancelled", "delivered"].includes(String(goal.status))) throw new Error("goal cannot be cancelled");
        const missing = db.prepare(`SELECT COUNT(*) AS n FROM goal_attempts a LEFT JOIN goal_dispatch_outbox o ON o.attempt_id=a.id
          WHERE a.goal_id=? AND o.attempt_id IS NULL`).get(value.goalId);
        if (Number(missing?.n) !== 0) throw new Error("active attempt has no dispatch record");
        const missingManager = db.prepare(`SELECT COUNT(*) AS n FROM goal_management_attempts a LEFT JOIN goal_dispatch_outbox o ON o.attempt_id=a.id
          WHERE a.goal_id=? AND o.attempt_id IS NULL`).get(value.goalId);
        if (Number(missingManager?.n) !== 0) throw new Error("management attempt has no dispatch record");
        const missingReview = db.prepare(`SELECT COUNT(*) AS n FROM goal_review_attempts a LEFT JOIN goal_dispatch_outbox o ON o.attempt_id=a.id
          WHERE a.goal_id=? AND o.attempt_id IS NULL`).get(value.goalId);
        if (Number(missingReview?.n) !== 0) throw new Error("review attempt has no dispatch record");
        db.prepare(`INSERT OR IGNORE INTO goal_stop_outbox (root_id, goal_id, attempt_id, dispatch_key, state)
          SELECT a.root_id, a.goal_id, a.id, o.dispatch_key, 'pending' FROM goal_attempts a JOIN goal_dispatch_outbox o ON o.attempt_id=a.id
          WHERE a.goal_id=?`).run(value.goalId);
        db.prepare(`INSERT OR IGNORE INTO goal_management_stop_outbox (root_id, goal_id, attempt_id, dispatch_key, state)
          SELECT a.root_id, a.goal_id, a.id, o.dispatch_key, 'pending' FROM goal_management_attempts a JOIN goal_dispatch_outbox o ON o.attempt_id=a.id
          WHERE a.goal_id=?`).run(value.goalId);
        db.prepare(`INSERT OR IGNORE INTO goal_review_stop_outbox (root_id, goal_id, attempt_id, dispatch_key, state)
          SELECT a.root_id, a.goal_id, a.id, o.dispatch_key, 'pending' FROM goal_review_attempts a JOIN goal_dispatch_outbox o ON o.attempt_id=a.id
          WHERE a.goal_id=?`).run(value.goalId);
        db.prepare("UPDATE goal_attempts SET status='reconciling' WHERE goal_id=? AND status IN ('prepared','queued','running','waiting','reconciling')").run(value.goalId);
        db.prepare("UPDATE goal_management_attempts SET status='reconciling' WHERE goal_id=? AND status IN ('prepared','queued','running','waiting','reconciling')").run(value.goalId);
        db.prepare("UPDATE goal_review_attempts SET status='reconciling' WHERE goal_id=? AND status IN ('prepared','queued','running','waiting','reconciling')").run(value.goalId);
        db.prepare("UPDATE goal_tasks SET status='cancelled' WHERE goal_id=? AND status NOT IN ('succeeded','superseded','cancelled')").run(value.goalId);
        const version = Number(goal.version) + 1;
        db.prepare("UPDATE goals SET status='cancelled', version=? WHERE id=?").run(version, value.goalId);
        addEvent.run(value.goalId, "cancel_requested", version, Date.now());
        return { goalId: value.goalId, version };
      });
    },
    pendingStops(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid stop batch size");
      return db.prepare(`SELECT root_id, goal_id, dispatch_key FROM (
        SELECT root_id, goal_id, dispatch_key, rowid AS position FROM goal_stop_outbox WHERE state='pending'
        UNION ALL SELECT root_id, goal_id, dispatch_key, rowid AS position FROM goal_management_stop_outbox WHERE state='pending'
        UNION ALL SELECT root_id, goal_id, dispatch_key, rowid AS position FROM goal_review_stop_outbox WHERE state='pending'
      ) ORDER BY position LIMIT ?`)
        .all(limit).map(row => ({ rootId: String(row.root_id), goalId: String(row.goal_id), dispatchKey: String(row.dispatch_key) }));
    },
    confirmStop(rootId: string) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const workStop = db.prepare("SELECT goal_id, attempt_id, state FROM goal_stop_outbox WHERE root_id=?").get(rootId);
        const managementStop = workStop ? undefined : db.prepare("SELECT goal_id, attempt_id, state FROM goal_management_stop_outbox WHERE root_id=?").get(rootId);
        const stop = workStop ?? managementStop ?? db.prepare("SELECT goal_id, attempt_id, state FROM goal_review_stop_outbox WHERE root_id=?").get(rootId);
        if (!stop) throw new Error("stop intent not found");
        if (stop.state === "confirmed") { db.exec("COMMIT"); return; }
        const goal = db.prepare("SELECT status FROM goals WHERE id=?").get(String(stop.goal_id));
        if (!goal || goal.status !== "cancelled") throw new Error("goal is not cancelled");
        const table = workStop ? "goal_stop_outbox" : managementStop ? "goal_management_stop_outbox" : "goal_review_stop_outbox";
        const attemptTable = workStop ? "goal_attempts" : managementStop ? "goal_management_attempts" : "goal_review_attempts";
        db.prepare(`UPDATE ${table} SET state='confirmed' WHERE root_id=?`).run(rootId);
        db.prepare(`UPDATE ${attemptTable} SET status='cancelled' WHERE id=? AND status='reconciling'`).run(String(stop.attempt_id));
        db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(String(stop.goal_id));
        db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'stop_confirmed', version, ? FROM goals WHERE id=?")
          .run(Date.now(), String(stop.goal_id));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    preparePlanning(input: { ownerId: string; commandId: string; goalId: string; expectedVersion: number; intent: DispatchIntent }) {
      const value = z.object({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
        expectedVersion: z.number().int().nonnegative(), intent: z.unknown() }).parse(input);
      const intent = parseDispatchIntent(value.intent);
      if (intent.goalId !== value.goalId || intent.request.delegation !== "deny") throw new Error("invalid planning dispatch");
      return execute("prepare-planning", { ...value, intent }, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        if (!goal || goal.status !== "planning" || !goalScopeActive(db, value.goalId) || Number(goal.version) !== value.expectedVersion || Number(goal.plan_revision) !== 0) {
          throw new Error("goal is not ready for planning or version conflict");
        }
        if (intent.request.assignee.botId !== goal.lead_bot_id || intent.request.assignee.destination.threadId !== goal.lead_thread_id) {
          throw new Error("planning assignee is not the goal lead");
        }
        bindWorkThread(db, value.goalId, intent.request.assignee.destination.threadId);
        const active = db.prepare("SELECT 1 FROM goal_management_attempts WHERE goal_id=? AND status IN ('prepared','queued','running','waiting','reconciling')").get(value.goalId);
        if (active) throw new Error("goal already has an active management attempt");
        if (Number(activeGoals.get()?.n) >= 2) throw new Error("workspace goal limit reached");
        const used = db.prepare("SELECT COUNT(*) AS n FROM goal_management_attempts WHERE goal_id=?").get(value.goalId);
        if (Number(used?.n) >= 30) throw new Error("management attempt limit reached");
        const now = Date.now();
        insertRoot.run(intent.request.rootId, value.goalId);
        insertManager.run(intent.attemptId, value.goalId, intent.request.rootId, intent.request.assignee.botId,
          intent.request.assignee.destination.threadId, Number(goal.requirement_revision), now);
        insertOutbox.run(intent.request.dispatchKey, intent.attemptId, intent.request.rootId, value.goalId, JSON.stringify(intent));
        const version = Number(goal.version) + 1;
        setVersion.run(version, value.goalId);
        addEvent.run(value.goalId, "planning_prepared", version, now);
        return { goalId: value.goalId, version };
      });
    },
    planningContext(context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean) {
      const bound = z.object({ rootId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
        executionNo: z.number().int().positive() }).parse(context);
      const row = db.prepare(`SELECT a.id AS attempt_id, a.status AS attempt_status, a.requirement_revision AS attempt_requirement,
        g.id AS goal_id, g.owner_id, g.title, g.original_request, g.requirement_revision, g.plan_revision, g.version, g.status AS goal_status,
        w.id AS workstream_id, w.area_id
        FROM goal_management_attempts a JOIN goals g ON g.id=a.goal_id
        JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
        WHERE a.root_id=? AND a.bot_id=? AND a.thread_id=? AND a.kind='plan'`).get(bound.rootId, bound.botId, bound.threadId);
      const pause = row?.goal_status === "paused" ? db.prepare("SELECT previous_status FROM goal_pause_state WHERE goal_id=?").get(String(row.goal_id)) : undefined;
      if (!row || (row.goal_status !== "planning" && !(row.goal_status === "paused" && ["planning", "waiting_user"].includes(String(pause?.previous_status)))) ||
        !["queued", "running"].includes(String(row.attempt_status)) ||
        Number(row.attempt_requirement) !== Number(row.requirement_revision) || isCurrentRun(bound) !== true) {
        throw new Error("planning run is not authorized or current");
      }
      return { goalId: String(row.goal_id), ownerId: String(row.owner_id), attemptId: String(row.attempt_id), title: String(row.title),
        request: String(row.original_request), areaId: String(row.area_id), workstreamId: String(row.workstream_id),
        requirementRevision: Number(row.requirement_revision), planRevision: Number(row.plan_revision), version: Number(row.version) };
    },
    roleForRun(context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean): "plan" | "work" | "review" | undefined {
      if (db.prepare("SELECT 1 FROM goal_management_attempts WHERE root_id=? AND kind='plan'").get(context.rootId)) {
        this.planningContext(context, isCurrentRun); return "plan";
      }
      if (db.prepare("SELECT 1 FROM goal_attempts WHERE root_id=?").get(context.rootId)) {
        workContext(context, isCurrentRun); return "work";
      }
      if (db.prepare("SELECT 1 FROM goal_review_attempts WHERE root_id=?").get(context.rootId)) {
        reviewContext(context, isCurrentRun); return "review";
      }
      return undefined;
    },
    prepareReview(input: { ownerId: string; commandId: string; goalId: string; taskId: string; expectedVersion: number; intent: DispatchIntent }) {
      const value = z.strictObject({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
        taskId: z.string().min(1), expectedVersion: z.number().int().nonnegative(), intent: z.unknown() }).parse(input);
      const intent = parseDispatchIntent(value.intent);
      if (intent.goalId !== value.goalId || intent.request.delegation !== "deny") throw new Error("invalid review dispatch");
      return execute("prepare-review", { ...value, intent }, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        if (!goal || goal.status !== "active" || Number(goal.version) !== value.expectedVersion || !goalScopeActive(db, value.goalId)) throw new Error("goal is not ready for review or version conflict");
        if (intent.request.assignee.botId !== goal.lead_bot_id || intent.request.assignee.destination.threadId !== goal.lead_thread_id) throw new Error("review assignee is not the goal lead");
        if (activeTask.get(value.taskId)) throw new Error("task still has an active work attempt");
        if (db.prepare("SELECT 1 FROM goal_review_attempts WHERE task_id=? AND status IN ('prepared','queued','running','waiting','reconciling','succeeded')").get(value.taskId)) throw new Error("task already has an active or unapplied review");
        if (Number(activeGoalCount.get(value.goalId)?.n) >= 2) throw new Error("goal concurrency limit reached");
        const managementCount = db.prepare(`SELECT (SELECT COUNT(*) FROM goal_management_attempts WHERE goal_id=?)
          + (SELECT COUNT(*) FROM goal_review_attempts WHERE goal_id=?1) AS n`).get(value.goalId);
        if (Number(managementCount?.n) >= 30) throw new Error("management attempt limit reached");
        const evidence = reviewEvidence(db, value.goalId, value.taskId);
        bindWorkThread(db, value.goalId, intent.request.assignee.destination.threadId);
        const activeHere = db.prepare(`SELECT 1 FROM (SELECT goal_id FROM goal_attempts WHERE status IN ('prepared','queued','running','waiting','reconciling')
          UNION ALL SELECT goal_id FROM goal_management_attempts WHERE status IN ('prepared','queued','running','waiting','reconciling')
          UNION ALL SELECT goal_id FROM goal_review_attempts WHERE status IN ('prepared','queued','running','waiting','reconciling')) WHERE goal_id=? LIMIT 1`).get(value.goalId);
        if (!activeHere && Number(activeGoals.get()?.n) >= 2) throw new Error("workspace goal limit reached");
        const now = Date.now();
        insertRoot.run(intent.request.rootId, value.goalId);
        db.prepare(`INSERT INTO goal_review_attempts (id, goal_id, task_id, root_id, bot_id, thread_id, evidence_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`).run(intent.attemptId, value.goalId, value.taskId, intent.request.rootId,
          intent.request.assignee.botId, intent.request.assignee.destination.threadId, JSON.stringify(evidence), now);
        insertOutbox.run(intent.request.dispatchKey, intent.attemptId, intent.request.rootId, value.goalId, JSON.stringify(intent));
        const version = Number(goal.version) + 1;
        setVersion.run(version, value.goalId); addEvent.run(value.goalId, "review_prepared", version, now);
        return { goalId: value.goalId, version };
      });
    },
    reviewContext,
    submitReviewFromRun(input: unknown, context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean,
      allowVersionAdvance?: (expectedVersion: number) => boolean) {
      const value = reviewResultSchema.parse(input);
      const bound = reviewContext(context, isCurrentRun);
      return execute("submit-review", { ...value, ownerId: bound.ownerId, context }, () => {
        const current = reviewContext(context, isCurrentRun);
        if (current.version !== value.expectedVersion && allowVersionAdvance?.(value.expectedVersion) !== true) throw new Error("review version conflict");
        const required = current.evidence.criteria.filter(c => c.required).map(c => c.id);
        if (new Set(value.verdicts.map(v => v.criterionId)).size !== value.verdicts.length || value.verdicts.length !== required.length ||
          value.verdicts.some(v => !required.includes(v.criterionId))) throw new Error("review must cover every required criterion");
        db.prepare("INSERT INTO goal_review_results VALUES (?, ?, ?)").run(current.attemptId, JSON.stringify(value), Date.now());
        const version = current.version + 1;
        setVersion.run(version, current.goalId); addEvent.run(current.goalId, "review_submitted", version, Date.now());
        return { goalId: current.goalId, version };
      });
    },
    async finalizeReview(input: { ownerId: string; commandId: string; goalId: string; taskId: string; reviewAttemptId: string; expectedVersion: number },
      resolveAuthorizedRoots: (workspaceRef: string) => readonly string[]) {
      const value = z.strictObject({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1), taskId: z.string().min(1),
        reviewAttemptId: z.string().min(1), expectedVersion: z.number().int().nonnegative() }).parse(input);
      const prior = command.get(value.ownerId, value.commandId);
      if (prior) {
        const hash = createHash("sha256").update(JSON.stringify({ kind: "finalize-review", input: value })).digest("hex");
        if (prior.request_hash !== hash) throw new Error("command id conflict");
        return JSON.parse(String(prior.result_json)) as { goalId: string; version: number };
      }
      const goal = getGoal.get(value.goalId, value.ownerId);
      const review = db.prepare("SELECT * FROM goal_review_attempts WHERE id=? AND goal_id=? AND task_id=?").get(value.reviewAttemptId, value.goalId, value.taskId);
      if (!goal || goal.status !== "active" || !goalScopeActive(db, value.goalId) || Number(goal.version) !== value.expectedVersion || !review || review.status !== "succeeded") throw new Error("review is not ready to finalize");
      const resultRow = db.prepare("SELECT result_json FROM goal_review_results WHERE attempt_id=?").get(value.reviewAttemptId);
      if (!resultRow) throw new Error("review result is missing");
      const result = reviewResultSchema.parse(JSON.parse(String(resultRow.result_json)));
      const evidence = reviewEvidence(db, value.goalId, value.taskId);
      if (JSON.stringify(evidence) !== review.evidence_json) throw new Error("review evidence is stale");
      if (result.verdicts.some(item => item.verdict !== "pass")) {
        const blocker = result.verdicts.some(item => item.verdict === "fail") ? "review_changes_requested" : "review_inconclusive";
        return execute("finalize-review", value, () => {
          const currentGoal = getGoal.get(value.goalId, value.ownerId);
          const currentReview = db.prepare("SELECT status, evidence_json FROM goal_review_attempts WHERE id=? AND goal_id=? AND task_id=?")
            .get(value.reviewAttemptId, value.goalId, value.taskId);
          if (!currentGoal || currentGoal.status !== "active" || !goalScopeActive(db, value.goalId) || Number(currentGoal.version) !== value.expectedVersion || !currentReview ||
            currentReview.status !== "succeeded" || currentReview.evidence_json !== JSON.stringify(reviewEvidence(db, value.goalId, value.taskId))) throw new Error("review evidence or goal changed");
          db.prepare("UPDATE goal_tasks SET status='blocked' WHERE id=? AND goal_id=? AND status='checking'").run(value.taskId, value.goalId);
          db.prepare("INSERT INTO goal_task_blockers (task_id, code) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET code=excluded.code").run(value.taskId, blocker);
          db.prepare("UPDATE goal_review_attempts SET status='rejected' WHERE id=?").run(value.reviewAttemptId);
          const version = Number(currentGoal.version) + 1;
          setVersion.run(version, value.goalId); refreshGoalState(value.goalId); addEvent.run(value.goalId, "review_rejected", version, Date.now());
          return { goalId: value.goalId, version };
        });
      }
      if (evidence.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) > 64 * 1024 * 1024) throw new Error("review artifacts exceed snapshot limit");
      const roots = resolveAuthorizedRoots(evidence.workspaceRef);
      const snapshots: { id: string; sha256: string; bytes: number; content: Buffer }[] = [];
      for (const artifact of evidence.artifacts) {
        try { snapshots.push({ id: artifact.id, sha256: artifact.sha256, bytes: artifact.bytes, content: await captureArtifact(artifact, roots) }); }
        catch { throw new Error("review artifact is changed or unavailable"); }
      }
      return execute("finalize-review", value, () => {
        const currentGoal = getGoal.get(value.goalId, value.ownerId);
        const currentReview = db.prepare("SELECT status, evidence_json FROM goal_review_attempts WHERE id=? AND goal_id=? AND task_id=?")
          .get(value.reviewAttemptId, value.goalId, value.taskId);
        if (!currentGoal || currentGoal.status !== "active" || !goalScopeActive(db, value.goalId) || Number(currentGoal.version) !== value.expectedVersion || !currentReview ||
          currentReview.status !== "succeeded" || currentReview.evidence_json !== JSON.stringify(reviewEvidence(db, value.goalId, value.taskId))) throw new Error("review evidence or goal changed");
        for (const snapshot of snapshots) {
          const previous = db.prepare("SELECT sha256, bytes, contents FROM goal_artifact_snapshots WHERE artifact_id=?").get(snapshot.id);
          if (previous) {
            if (previous.sha256 !== snapshot.sha256 || Number(previous.bytes) !== snapshot.bytes ||
              !Buffer.from(previous.contents as Uint8Array).equals(snapshot.content)) throw new Error("artifact snapshot conflict");
          } else db.prepare("INSERT INTO goal_artifact_snapshots VALUES (?, ?, ?, ?, ?)").run(snapshot.id, snapshot.sha256, snapshot.bytes, snapshot.content, Date.now());
        }
        db.prepare("UPDATE goal_tasks SET status='succeeded' WHERE id=? AND goal_id=? AND status='checking'").run(value.taskId, value.goalId);
        db.prepare("UPDATE goal_review_attempts SET status='applied' WHERE id=?").run(value.reviewAttemptId);
        const version = Number(currentGoal.version) + 1;
        setVersion.run(version, value.goalId); refreshGoalState(value.goalId); addEvent.run(value.goalId, "task_succeeded", version, Date.now());
        return { goalId: value.goalId, version };
      });
    },
    readArtifactSnapshot(input: { goalId: string; ownerId: string; artifactId: string }) {
      const value = z.strictObject({ goalId: z.string().min(1), ownerId: z.string().min(1), artifactId: z.string().min(1) }).parse(input);
      const row = db.prepare(`SELECT s.contents, s.sha256, s.bytes FROM goal_artifact_snapshots s JOIN goal_artifacts a ON a.id=s.artifact_id
        JOIN goals g ON g.id=a.goal_id WHERE g.id=? AND g.owner_id=? AND a.id=?`).get(value.goalId, value.ownerId, value.artifactId);
      if (!row) return undefined;
      const bytes = Buffer.from(row.contents as Uint8Array);
      if (bytes.length !== Number(row.bytes) || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("artifact snapshot is corrupted");
      return bytes;
    },
    workContext,
    submitTaskResultFromRun(input: unknown, context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean,
      allowVersionAdvance?: (expectedVersion: number) => boolean) {
      const value = resultSchema.parse(input);
      const bound = z.object({ rootId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
        executionNo: z.number().int().positive() }).parse(context);
      const current = workContext(bound, isCurrentRun);
      const commandInput = { ...value, ownerId: current.ownerId, context: bound };
      return execute("task-result", commandInput, () => {
        const fresh = workContext(bound, isCurrentRun);
        if ((fresh.version !== value.expectedVersion && allowVersionAdvance?.(value.expectedVersion) !== true) || fresh.requirementRevision !== value.requirementRevision ||
          fresh.planRevision !== value.planRevision) throw new Error("task result version conflict");
        if (new Set(value.artifactIds).size !== value.artifactIds.length || new Set(value.claims.map(c => c.criterionId)).size !== value.claims.length) {
          throw new Error("duplicate result reference");
        }
        const criteria = new Set(fresh.task.criteria.map(c => c.id));
        if (value.claims.length !== criteria.size || value.claims.some(c => !criteria.has(c.criterionId))) throw new Error("result must declare every criterion");
        for (const id of value.artifactIds) {
          const artifact = db.prepare("SELECT 1 FROM goal_artifacts WHERE id=? AND goal_id=? AND task_id=? AND attempt_id=?")
            .get(id, fresh.goalId, fresh.taskId, fresh.attemptId);
          if (!artifact) throw new Error("result references an unavailable artifact");
        }
        const now = Date.now();
        db.prepare("INSERT INTO goal_task_results VALUES (?, ?, ?, ?, ?, ?, ?)").run(fresh.attemptId, fresh.goalId, fresh.taskId,
          fresh.requirementRevision, fresh.planRevision, JSON.stringify(value), now);
        const version = fresh.version + 1;
        setVersion.run(version, fresh.goalId);
        addEvent.run(fresh.goalId, "task_result_submitted", version, now);
        return { goalId: fresh.goalId, version };
      });
    },
    submitPlanFromRun(input: GoalPlan, context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean,
      allowVersionAdvance?: (expectedVersion: number) => boolean) {
      const value = planSchema.parse(input);
      const bound = z.object({ rootId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
        executionNo: z.number().int().positive() }).parse(context);
      assertDag(value.tasks);
      return execute("managed-initial-plan", { ...value, context: bound }, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        const pause = goal?.status === "paused" ? db.prepare("SELECT previous_status FROM goal_pause_state WHERE goal_id=?").get(value.goalId) : undefined;
        if (!goal || (goal.status !== "planning" && !(goal.status === "paused" && ["planning", "waiting_user"].includes(String(pause?.previous_status)))) ||
          (Number(goal.version) !== value.expectedVersion && allowVersionAdvance?.(value.expectedVersion) !== true) ||
          Number(goal.requirement_revision) !== value.requirementRevision || Number(goal.plan_revision) !== 0) throw new Error("goal is not ready for this plan or version conflict");
        const attempt = db.prepare(`SELECT * FROM goal_management_attempts WHERE id=? AND goal_id=? AND kind='plan'
          AND root_id=? AND bot_id=? AND thread_id=?`).get(value.sourceAttemptId, value.goalId, bound.rootId, bound.botId, bound.threadId);
        if (!attempt || !["queued", "running"].includes(String(attempt.status)) || Number(attempt.requirement_revision) !== value.requirementRevision ||
          isCurrentRun(bound) !== true) throw new Error("planning run is not authorized or current");
        return writeInitialPlan(value, Number(goal.version) + 1, goal.status === "paused" ? "paused" : "planning");
      });
    },
    /** Bootstrap/test-only: never expose this unbound method to an agent or external client. */
    submitInitialPlanUnchecked(input: GoalPlan) {
      if (options.unsafeTestPlanBootstrap !== true) throw new Error("unbound plan submission is disabled");
      const value = planSchema.parse(input);
      assertDag(value.tasks);
      return execute("initial-plan", value, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        if (!goal) throw new Error("goal not found");
        if (Number(goal.version) !== value.expectedVersion || Number(goal.requirement_revision) !== value.requirementRevision) throw new Error("version conflict");
        if (Number(goal.plan_revision) !== 0 || goal.status !== "planning") throw new Error("initial plan already exists");
        if (db.prepare("SELECT 1 FROM goal_management_attempts WHERE goal_id=? LIMIT 1").get(value.goalId)) throw new Error("planning run requires a bound submission");
        const version = Number(goal.version) + 1;
        return writeInitialPlan(value, version, "active");
      });
    },
    prepareWork(input: { ownerId: string; commandId: string; goalId: string; taskId: string; expectedVersion: number; intent: DispatchIntent },
      resolveWritableWorkspace: (workspaceRef: string) => string) {
      const value = z.object({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1),
        taskId: z.string().min(1), expectedVersion: z.number().int().nonnegative(), intent: z.unknown() }).parse(input);
      const intent = parseDispatchIntent(value.intent);
      if (intent.goalId !== value.goalId) throw new Error("dispatch belongs to another goal");
      const normalized = { ...value, intent };
      return execute("prepare-work", normalized, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        if (!goal || goal.status !== "active" || !goalScopeActive(db, value.goalId)) throw new Error("goal or work scope is not active");
        if (Number(goal.version) !== value.expectedVersion) throw new Error("version conflict");
        const row = readTask.get(value.taskId, value.goalId);
        if (!row || row.status !== "planned" || row.plan_revision !== goal.plan_revision) throw new Error("task is not planned");
        const task = taskSchema.parse(JSON.parse(String(row.task_json)));
        if (task.assigneeBotId !== intent.request.assignee.botId) throw new Error("dispatch assignee mismatch");
        bindWorkThread(db, value.goalId, intent.request.assignee.destination.threadId);
        if (Number(unfinishedDependencies.get(value.goalId, value.taskId)?.n) !== 0) throw new Error("dependencies are not complete");
        if (activeTask.get(value.taskId)) throw new Error("task already has an active attempt");
        if (Number(activeGoalCount.get(value.goalId)?.n) >= 2) throw new Error("goal concurrency limit reached");
        if (Number(activeGoalCount.get(value.goalId)?.n) === 0 && Number(activeGoals.get()?.n) >= 2) throw new Error("workspace goal limit reached");
        if (Number(attemptCount.get(value.goalId)?.n) >= 40) throw new Error("work attempt limit reached");
        const workspace = resolveWritableWorkspace(task.workspaceRef);
        if (!workspace) throw new Error("workspace could not be resolved");
        if (activeWorkspace.get(workspace)) throw new Error("workspace already has an active writer");
        const now = Date.now();
        insertRoot.run(intent.request.rootId, value.goalId);
        insertAttempt.run(intent.attemptId, value.goalId, value.taskId, intent.request.rootId, workspace, now);
        bindTaskInputs(db, value.goalId, intent.attemptId, task.dependsOn);
        if (!taskInputsCurrent(db, value.goalId, intent.attemptId)) throw new Error("dependency inputs are stale");
        insertOutbox.run(intent.request.dispatchKey, intent.attemptId, intent.request.rootId, value.goalId, JSON.stringify(intent));
        readyTask.run(value.taskId, value.goalId);
        const version = Number(goal.version) + 1;
        setVersion.run(version, value.goalId);
        addEvent.run(value.goalId, "work_prepared", version, now);
        return { goalId: value.goalId, version };
      });
    },
    listWorkInputs(context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean) {
      const current = workContext(context, isCurrentRun);
      return db.prepare("SELECT predecessor_task_id, artifact_id, logical_name, sha256, bytes FROM goal_attempt_inputs WHERE attempt_id=? ORDER BY predecessor_task_id, artifact_id")
        .all(current.attemptId).map(row => ({ predecessorTaskId: String(row.predecessor_task_id), artifactId: String(row.artifact_id),
          logicalName: String(row.logical_name), sha256: String(row.sha256), bytes: Number(row.bytes) }));
    },
    readWorkInput(context: GoalRunContext, isCurrentRun: (context: GoalRunContext) => boolean, artifactId: string, offset: number, length: number) {
      const current = workContext(context, isCurrentRun);
      return readInputSnapshot(db, current.attemptId, z.string().min(1).parse(artifactId), offset, length);
    },
    async registerArtifact(input: z.infer<typeof artifactSchema>, resolveAuthorizedRoots: (workspaceRef: string) => readonly string[],
      verifyCurrent: () => boolean, allowVersionAdvance?: () => boolean) {
      const value = artifactSchema.parse(input);
      const existing = command.get(value.ownerId, value.commandId);
      if (existing) {
        const hash = createHash("sha256").update(JSON.stringify({ kind: "register-artifact", input: value })).digest("hex");
        if (existing.request_hash !== hash) throw new Error("command id conflict");
        return JSON.parse(String(existing.result_json)) as { goalId: string; version: number; artifactId: string; revision: number };
      }
      const before = getGoal.get(value.goalId, value.ownerId);
      const taskRow = readTask.get(value.taskId, value.goalId);
      if (!before || !taskRow) throw new Error("goal or task not found");
      const task = taskSchema.parse(JSON.parse(String(taskRow.task_json)));
      const inspected = await inspectArtifact(value.reference, resolveAuthorizedRoots(task.workspaceRef));
      return execute("register-artifact", value, () => {
        const goal = getGoal.get(value.goalId, value.ownerId);
        const current = readTask.get(value.taskId, value.goalId);
        const attempt = taskAttempt.get(value.attemptId, value.taskId, value.goalId);
        const pause = goal?.status === "paused" ? db.prepare("SELECT previous_status FROM goal_pause_state WHERE goal_id=?").get(value.goalId) : undefined;
        if (!goal || verifyCurrent() !== true || (Number(goal.version) !== value.expectedVersion && allowVersionAdvance?.() !== true) ||
          !(goal.status === "active" || (goal.status === "paused" && pause?.previous_status === "active"))) throw new Error("version conflict");
        if (!current || current.plan_revision !== goal.plan_revision || !["running", "waiting_user", "checking"].includes(String(current.status))) throw new Error("task cannot register artifacts");
        if (!attempt || !["queued", "running", "waiting", "succeeded"].includes(String(attempt.status))) throw new Error("attempt cannot register artifacts");
        const latest = db.prepare("SELECT id, attempt_id, revision, reference, sha256, bytes FROM goal_artifacts WHERE task_id=? AND logical_name=? ORDER BY revision DESC LIMIT 1")
          .get(value.taskId, value.logicalName);
        if (latest && latest.attempt_id === value.attemptId && latest.reference === inspected.reference && latest.sha256 === inspected.sha256 && Number(latest.bytes) === inspected.bytes) {
          return { goalId: value.goalId, version: Number(goal.version), artifactId: String(latest.id), revision: Number(latest.revision) };
        }
        const revision = Number(artifactRevision.get(value.taskId, value.logicalName)?.revision) + 1;
        const now = Date.now();
        insertArtifact.run(value.artifactId, value.goalId, value.taskId, value.attemptId, value.logicalName, revision,
          inspected.reference, inspected.sha256, inspected.bytes, inspected.mediaType, Number(goal.requirement_revision), now);
        const version = Number(goal.version) + 1;
        setVersion.run(version, value.goalId);
        addEvent.run(value.goalId, "artifact_registered", version, now);
        return { goalId: value.goalId, version, artifactId: value.artifactId, revision };
      });
    },
    async checkRegisteredArtifact(input: z.infer<typeof artifactCheckSchema>, resolveAuthorizedRoots: (workspaceRef: string) => readonly string[]) {
      const value = artifactCheckSchema.parse(input);
      const existing = command.get(value.ownerId, value.commandId);
      if (existing) {
        const hash = createHash("sha256").update(JSON.stringify({ kind: "check-artifact", input: value })).digest("hex");
        if (existing.request_hash !== hash) throw new Error("command id conflict");
        return JSON.parse(String(existing.result_json)) as { goalId: string; version: number };
      }
      const goal = getGoal.get(value.goalId, value.ownerId);
      const row = readTask.get(value.taskId, value.goalId);
      const artifact = readArtifact.get(value.artifactId, value.taskId, value.goalId);
      if (!goal || !row || !artifact) throw new Error("goal, task or artifact not found");
      const attempt = db.prepare("SELECT id, status FROM goal_attempts WHERE goal_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(value.goalId, value.taskId);
      const result = attempt ? db.prepare("SELECT result_json FROM goal_task_results WHERE attempt_id=?").get(String(attempt.id)) : undefined;
      if (!attempt || attempt.status !== "succeeded" || artifact.attempt_id !== attempt.id || !result ||
        !resultSchema.parse(JSON.parse(String(result.result_json))).artifactIds.includes(value.artifactId)) throw new Error("artifact is not in the current task result");
      const task = taskSchema.parse(JSON.parse(String(row.task_json)));
      const criterion = task.criteria.find(c => c.id === value.criterionId);
      if (!criterion || !["artifact_exists", "json_schema"].includes(criterion.kind) || criterion.config.logicalName !== artifact.logical_name) {
        throw new Error("artifact does not match criterion");
      }
      const expected = { reference: String(artifact.reference), sha256: String(artifact.sha256), bytes: Number(artifact.bytes) };
      const roots = resolveAuthorizedRoots(task.workspaceRef);
      const verdict = criterion.kind === "json_schema"
        ? await checkJsonSchema(expected, jsonConfigSchema.parse(criterion.config).schema, roots)
        : await checkArtifact(expected, roots, artifactConfigSchema.parse(criterion.config));
      return execute("check-artifact", value, () => {
        const currentGoal = getGoal.get(value.goalId, value.ownerId);
        const currentTask = readTask.get(value.taskId, value.goalId);
        const currentArtifact = readArtifact.get(value.artifactId, value.taskId, value.goalId);
        if (!currentGoal || currentGoal.status !== "active" || !goalScopeActive(db, value.goalId) || Number(currentGoal.version) !== value.expectedVersion) throw new Error("version conflict");
        if (!currentTask || currentTask.status !== "checking" || currentTask.plan_revision !== currentGoal.plan_revision || !currentArtifact ||
          currentArtifact.sha256 !== artifact.sha256 || currentArtifact.requirement_revision !== currentGoal.requirement_revision ||
          Number(artifactRevision.get(value.taskId, String(currentArtifact.logical_name))?.revision) !== Number(currentArtifact.revision)) throw new Error("check inputs are stale");
        const now = Date.now();
        insertCheck.run(value.checkId, value.goalId, value.taskId, value.criterionId, value.artifactId, String(artifact.sha256),
          Number(currentGoal.requirement_revision), verdict, now);
        const version = Number(currentGoal.version) + 1;
        setVersion.run(version, value.goalId);
        addEvent.run(value.goalId, "artifact_checked", version, now);
        return { goalId: value.goalId, version };
      });
    },
    applyRuntimeTransition(eventId: number, root: Assignment, held = false): "applied" | "duplicate" | "ignored" {
      if (!Number.isSafeInteger(eventId) || eventId < 1 || root.parentId !== undefined || root.rootId !== root.id) throw new Error("invalid runtime transition");
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = db.prepare("SELECT root_id FROM goal_inbox WHERE source='runtime' AND source_event_id=?").get(eventId);
        if (prior) {
          if (prior.root_id !== root.id) throw new Error("runtime event identity conflict");
          db.exec("COMMIT");
          return "duplicate";
        }
        const attempt = db.prepare("SELECT id, goal_id, task_id, status, last_event_id FROM goal_attempts WHERE root_id=?").get(root.id);
        const manager = attempt ? undefined : db.prepare("SELECT id, goal_id, status, last_event_id FROM goal_management_attempts WHERE root_id=?").get(root.id);
        const review = attempt || manager ? undefined : db.prepare("SELECT id, goal_id, task_id, status, last_event_id FROM goal_review_attempts WHERE root_id=?").get(root.id);
        if (!attempt && !manager && !review) throw new Error("runtime root is not associated with an attempt");
        db.prepare("INSERT INTO goal_inbox VALUES ('runtime', ?, ?)").run(eventId, root.id);
        const current = attempt ?? manager ?? review!;
        const goal = db.prepare("SELECT status, plan_revision, requirement_revision FROM goals WHERE id=?").get(String(current.goal_id));
        if (!goal) throw new Error("runtime goal is missing");
        if (goal.status === "cancelled") {
          const table = attempt ? "goal_attempts" : manager ? "goal_management_attempts" : "goal_review_attempts";
          db.prepare(`UPDATE ${table} SET last_event_id=MAX(last_event_id, ?) WHERE id=?`).run(eventId, String(current.id));
          db.exec("COMMIT");
          return "ignored";
        }
        if (eventId <= Number(current.last_event_id) || ["succeeded", "failed", "cancelled", "applied", "rejected"].includes(String(current.status))) {
          db.exec("COMMIT");
          return "ignored";
        }
        if (review) {
          const status = held && !["completed", "failed", "cancelled"].includes(root.status) ? "reconciling"
            : root.status === "completed" ? "succeeded" : root.status === "failed" ? "failed" : root.status === "cancelled" ? "cancelled"
              : root.status === "needs_input" || root.status === "waiting" || root.status === "resume" ? "waiting" : root.status;
          const result = db.prepare("SELECT 1 FROM goal_review_results WHERE attempt_id=?").get(String(review.id));
          const blocked = ["failed", "cancelled", "reconciling"].includes(status) || (status === "succeeded" && !result);
          db.prepare("UPDATE goal_review_attempts SET status=?, last_event_id=? WHERE id=?").run(status, eventId, String(review.id));
          if (blocked) {
            db.prepare("UPDATE goal_tasks SET status='blocked' WHERE id=? AND goal_id=?").run(String(review.task_id), String(review.goal_id));
            db.prepare("INSERT INTO goal_task_blockers (task_id, code) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET code=excluded.code")
              .run(String(review.task_id), status === "succeeded" ? "incomplete_review" : "review_interrupted");
          }
          db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(String(review.goal_id));
          refreshGoalState(String(review.goal_id));
          db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'review_transition', version, ? FROM goals WHERE id=?")
            .run(Date.now(), String(review.goal_id));
          db.exec("COMMIT");
          return "applied";
        }
        if (manager) {
          const status = held && !["completed", "failed", "cancelled"].includes(root.status) ? "reconciling"
            : root.status === "completed" ? "succeeded" : root.status === "failed" ? "failed" : root.status === "cancelled" ? "cancelled"
              : root.status === "needs_input" || root.status === "waiting" || root.status === "resume" ? "waiting" : root.status;
          db.prepare("UPDATE goal_management_attempts SET status=?, last_event_id=? WHERE id=?").run(status, eventId, String(manager.id));
          let goalStatus = String(goal.status);
          if (goalStatus !== "paused") {
            if (status === "reconciling" || status === "failed" || status === "cancelled") goalStatus = "blocked";
            else if (root.status === "needs_input") goalStatus = "waiting_user";
            else if (status === "succeeded") {
              const submitted = db.prepare("SELECT 1 FROM goal_plans WHERE goal_id=? AND revision=? AND source_attempt_id=?")
                .get(String(manager.goal_id), Number(goal.plan_revision), String(manager.id));
              goalStatus = submitted ? "active" : "blocked";
            } else if (goalStatus === "waiting_user") goalStatus = "planning";
          }
          db.prepare("UPDATE goals SET status=?, version=version+1 WHERE id=?").run(goalStatus, String(manager.goal_id));
          db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'planning_transition', version, ? FROM goals WHERE id=?")
            .run(Date.now(), String(manager.goal_id));
          db.exec("COMMIT");
          return "applied";
        }
        const mapping: Record<Assignment["status"], { attempt: string; task: string }> = {
          queued: { attempt: "queued", task: "running" }, running: { attempt: "running", task: "running" },
          waiting: { attempt: "waiting", task: "running" }, resume: { attempt: "waiting", task: "running" },
          needs_input: { attempt: "waiting", task: "waiting_user" }, completed: { attempt: "succeeded", task: "checking" },
          failed: { attempt: "failed", task: "blocked" }, cancelled: { attempt: "cancelled", task: "blocked" },
        };
        const next = held && !["completed", "failed", "cancelled"].includes(root.status)
          ? { attempt: "reconciling", task: "blocked" } : mapping[root.status];
        let blocker: string | undefined;
        if (next.attempt === "reconciling") blocker = "interrupted_needs_reconciliation";
        else if (root.status === "failed" || root.status === "cancelled") blocker = "runtime_did_not_complete";
        else if (!taskInputsCurrent(db, String(attempt!.goal_id), String(attempt!.id))) { next.task = "blocked"; blocker = "stale_inputs"; }
        else if (root.status === "completed") {
          const result = db.prepare(`SELECT 1 FROM goal_task_results WHERE attempt_id=? AND goal_id=? AND task_id=?
            AND requirement_revision=? AND plan_revision=?`).get(String(attempt!.id), String(attempt!.goal_id), String(attempt!.task_id),
            Number(goal.requirement_revision), Number(goal.plan_revision));
          if (!result) { next.task = "blocked"; blocker = "incomplete_output"; }
        }
        if (blocker) db.prepare("INSERT INTO goal_task_blockers (task_id, code) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET code=excluded.code")
          .run(String(attempt!.task_id), blocker);
        else db.prepare("DELETE FROM goal_task_blockers WHERE task_id=?").run(String(attempt!.task_id));
        db.prepare("UPDATE goal_attempts SET status=?, last_event_id=? WHERE id=?").run(next.attempt, eventId, String(attempt!.id));
        db.prepare("UPDATE goal_tasks SET status=? WHERE id=? AND goal_id=?").run(next.task, String(attempt!.task_id), String(attempt!.goal_id));
        db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(String(attempt!.goal_id));
        refreshGoalState(String(attempt!.goal_id));
        db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'runtime_transition', version, ? FROM goals WHERE id=?")
          .run(Date.now(), String(attempt!.goal_id));
        db.exec("COMMIT");
        return "applied";
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    runtimeCursor(): number {
      return Number(db.prepare("SELECT seq FROM goal_scheduler_cursor WHERE source='runtime'").get()?.seq);
    },
    readyWork(afterGoalId: string, afterTaskId: string, limit: number, workstreamId = "") {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid ready-work batch size");
      const rows = db.prepare(`SELECT g.id AS goal_id, g.owner_id, g.version, g.plan_revision, t.task_json, w.id AS workstream_id
        FROM goals g JOIN goal_tasks t ON t.goal_id=g.id AND t.plan_revision=g.plan_revision
        JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id
        JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
        JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
        WHERE g.status='active' AND w.status='active' AND a.status='active' AND (?='' OR w.id=?)
          AND (g.id>? OR (g.id=? AND t.id>?)) AND t.status='planned'
          AND NOT EXISTS (SELECT 1 FROM goal_dependencies d JOIN goal_tasks p ON p.id=d.depends_on_id
            WHERE d.goal_id=g.id AND d.task_id=t.id AND p.status<>'succeeded')
          AND NOT EXISTS (SELECT 1 FROM goal_attempts a WHERE a.task_id=t.id AND a.status IN ('prepared','queued','running','waiting','reconciling'))
        ORDER BY g.id, t.id LIMIT ?`).all(workstreamId, workstreamId, afterGoalId, afterGoalId, afterTaskId, limit);
      return rows.map(row => ({ goalId: String(row.goal_id), ownerId: String(row.owner_id), version: Number(row.version), workstreamId: String(row.workstream_id),
        planRevision: Number(row.plan_revision), task: taskSchema.parse(JSON.parse(String(row.task_json))) }));
    },
    auditStaleInputs(afterGoalId: string, afterTaskId: string, limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid input audit batch size");
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db.prepare(`SELECT t.id AS task_id, t.goal_id, a.id AS attempt_id FROM goal_tasks t JOIN goals g ON g.id=t.goal_id
          JOIN goal_attempts a ON a.id=(SELECT x.id FROM goal_attempts x WHERE x.task_id=t.id AND x.goal_id=t.goal_id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
          WHERE g.status IN ('active','waiting_user','blocked','paused') AND t.status IN ('ready','running','waiting_user','checking','succeeded')
          AND EXISTS (SELECT 1 FROM goal_dependencies d WHERE d.goal_id=t.goal_id AND d.task_id=t.id)
          AND (t.goal_id>? OR (t.goal_id=? AND t.id>?)) ORDER BY t.goal_id, t.id LIMIT ?`).all(afterGoalId, afterGoalId, afterTaskId, limit);
        for (const row of rows) {
          const goalId = String(row.goal_id), taskId = String(row.task_id);
          if (taskInputsCurrent(db, goalId, String(row.attempt_id))) continue;
          db.prepare("UPDATE goal_tasks SET status='blocked' WHERE id=? AND goal_id=?").run(taskId, goalId);
          db.prepare("INSERT INTO goal_task_blockers (task_id, code) VALUES (?, 'stale_inputs') ON CONFLICT(task_id) DO UPDATE SET code=excluded.code").run(taskId);
          db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(goalId);
          refreshGoalState(goalId);
          db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'inputs_stale', version, ? FROM goals WHERE id=?").run(Date.now(), goalId);
        }
        db.exec("COMMIT");
        const last = rows.at(-1);
        return { scanned: rows.length, cursor: last ? { goalId: String(last.goal_id), taskId: String(last.task_id) } : undefined };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    readyWorkstreams(afterId: string, limit: number): string[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid ready-workstream batch size");
      return db.prepare(`SELECT DISTINCT w.id FROM work_streams w JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
        JOIN goal_workstreams x ON x.workstream_id=w.id AND x.owner_id=w.owner_id JOIN goals g ON g.id=x.goal_id AND g.owner_id=x.owner_id
        JOIN goal_tasks t ON t.goal_id=g.id AND t.plan_revision=g.plan_revision
        WHERE w.id>? AND w.status='active' AND a.status='active' AND g.status='active' AND t.status='planned'
          AND NOT EXISTS (SELECT 1 FROM goal_dependencies d JOIN goal_tasks p ON p.id=d.depends_on_id
            WHERE d.goal_id=g.id AND d.task_id=t.id AND p.status<>'succeeded')
          AND NOT EXISTS (SELECT 1 FROM goal_attempts at WHERE at.task_id=t.id AND at.status IN ('prepared','queued','running','waiting','reconciling'))
        ORDER BY w.id LIMIT ?`).all(afterId, limit).map(row => String(row.id));
    },
    readyReviews(afterGoalId: string, afterTaskId: string, limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid review batch size");
      return db.prepare(`SELECT g.id AS goal_id, g.owner_id, g.version, t.id AS task_id, w.id AS workstream_id
        FROM goals g JOIN goal_tasks t ON t.goal_id=g.id AND t.plan_revision=g.plan_revision
        JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id
        JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
        JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
        WHERE g.status='active' AND t.status='checking' AND w.status='active' AND a.status='active'
          AND (g.id>? OR (g.id=? AND t.id>?))
          AND NOT EXISTS (SELECT 1 FROM goal_review_attempts r WHERE r.task_id=t.id AND r.status IN ('prepared','queued','running','waiting','reconciling','succeeded'))
        ORDER BY g.id, t.id LIMIT ?`).all(afterGoalId, afterGoalId, afterTaskId, limit).map(row => ({ goalId: String(row.goal_id),
        ownerId: String(row.owner_id), version: Number(row.version), taskId: String(row.task_id), workstreamId: String(row.workstream_id) }));
    },
    nextAutomaticAction(afterGoalId: string, afterTaskId: string, limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid automatic-work batch size");
      return nextAutomaticAction(db, afterGoalId, afterTaskId, limit);
    },
    blockAutomaticAction(input: { ownerId: string; commandId: string; goalId: string; taskId: string; expectedVersion: number;
      code: "missing_artifact" | "check_failed" | "check_unknown" | "stale_inputs" }) {
      const value = z.strictObject({ ownerId: z.string().min(1), commandId: z.string().min(1), goalId: z.string().min(1), taskId: z.string().min(1),
        expectedVersion: z.number().int().nonnegative(), code: z.enum(["missing_artifact", "check_failed", "check_unknown", "stale_inputs"]) }).parse(input);
      return execute("automatic-block", value, () => {
        const action = automaticActionForTask(db, value.goalId, value.taskId);
        if (!action || action.kind !== "block" || action.ownerId !== value.ownerId || action.expectedVersion !== value.expectedVersion || action.code !== value.code) {
          throw new Error("automatic check state changed");
        }
        db.prepare("UPDATE goal_tasks SET status='blocked' WHERE id=? AND goal_id=? AND status='checking'").run(value.taskId, value.goalId);
        db.prepare("INSERT INTO goal_task_blockers (task_id, code) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET code=excluded.code").run(value.taskId, value.code);
        const version = value.expectedVersion + 1;
        setVersion.run(version, value.goalId); refreshGoalState(value.goalId); addEvent.run(value.goalId, "automatic_check_blocked", version, Date.now());
        return { goalId: value.goalId, version };
      });
    },
    advanceRuntimeCursor(from: number, to: number): void {
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error("invalid runtime cursor");
      if (db.prepare("UPDATE goal_scheduler_cursor SET seq=? WHERE source='runtime' AND seq=?").run(to, from).changes !== 1) {
        throw new Error("runtime cursor conflict");
      }
    },
    read(goalId: string, ownerId: string) {
      const goal = getGoal.get(goalId, ownerId);
      if (!goal) return undefined;
      const scope = db.prepare(`SELECT w.id AS workstream_id, w.area_id FROM goal_workstreams x JOIN work_streams w
        ON w.id=x.workstream_id AND w.owner_id=x.owner_id WHERE x.goal_id=? AND x.owner_id=?`).get(goalId, ownerId);
      return { id: String(goal.id), ownerId: String(goal.owner_id), title: String(goal.title), request: String(goal.original_request),
        areaId: String(scope?.area_id), workstreamId: String(scope?.workstream_id),
        leadBotId: String(goal.lead_bot_id), leadThreadId: String(goal.lead_thread_id),
        status: String(goal.status), requirementRevision: Number(goal.requirement_revision), planRevision: Number(goal.plan_revision),
        version: Number(goal.version), stopPending: Boolean(db.prepare(`SELECT 1 FROM goal_stop_outbox WHERE goal_id=? AND state='pending'
          UNION ALL SELECT 1 FROM goal_management_stop_outbox WHERE goal_id=? AND state='pending'
          UNION ALL SELECT 1 FROM goal_review_stop_outbox WHERE goal_id=? AND state='pending' LIMIT 1`).get(goalId, goalId, goalId)),
        managementAttempts: db.prepare("SELECT id, kind, root_id, status FROM goal_management_attempts WHERE goal_id=? ORDER BY created_at, rowid").all(goalId)
          .map(row => ({ id: String(row.id), kind: String(row.kind), rootId: String(row.root_id), status: String(row.status) })),
        reviewAttempts: db.prepare(`SELECT r.id, r.task_id, r.root_id, r.status, v.result_json FROM goal_review_attempts r
          LEFT JOIN goal_review_results v ON v.attempt_id=r.id WHERE r.goal_id=? ORDER BY r.created_at, r.rowid`).all(goalId)
          .map(row => ({ id: String(row.id), taskId: String(row.task_id), rootId: String(row.root_id), status: String(row.status),
            ...(row.result_json ? { verdicts: reviewResultSchema.parse(JSON.parse(String(row.result_json))).verdicts } : {}) })),
        tasks: readTasks.all(goalId).map(row => {
          const task = taskSchema.parse(JSON.parse(String(row.task_json)));
          const blocker = db.prepare("SELECT code FROM goal_task_blockers WHERE task_id=?").get(task.id);
          return { ...task, status: String(row.status), ...(blocker ? { blocker: String(blocker.code) } : {}) };
        }),
        artifacts: readArtifacts.all(goalId).map(row => ({ id: String(row.id), taskId: String(row.task_id), attemptId: String(row.attempt_id),
          logicalName: String(row.logical_name), revision: Number(row.revision), reference: String(row.reference), sha256: String(row.sha256),
          bytes: Number(row.bytes), mediaType: String(row.media_type) })),
        checks: readChecks.all(goalId).map(row => ({ id: String(row.id), taskId: String(row.task_id), criterionId: String(row.criterion_id),
          artifactId: String(row.artifact_id), sha256: String(row.artifact_sha256), verdict: String(row.verdict) })) };
    },
    close() { db.close(); },
  };
}
