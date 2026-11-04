import { GOAL_SCHEMA_VERSION } from "./schema-version.ts";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
import type { ClientRootRequest } from "../runtime/runtime.ts";
import { goalScopeActive } from "./work-scopes.ts";
import { taskInputsCurrent } from "./task-inputs.ts";

const dispatchSchema = z.object({
  goalId: z.string().min(1), attemptId: z.string().min(1), authorizationRef: z.string().min(1),
  request: z.object({
    dispatchKey: z.string().min(1), rootId: z.string().min(1), requesterRef: z.string().min(1),
    origin: z.object({ kind: z.enum(["person", "routine", "outside"]),
      source: z.enum(["chat", "routine", "webhook", "relay", "external_runtime", "guest", "peer", "api"]),
      ref: z.string().optional(), quote: z.string().optional(), onBehalfOf: z.string().optional() }),
    assignee: z.object({ botId: z.string().min(1), destination: z.object({ kind: z.enum(["work_thread", "standing_thread", "room_thread"]),
      threadId: z.string().min(1), groupId: z.string().optional() }) }),
    brief: z.string().min(1).max(12_000), doneWhen: z.string().optional(), level: z.enum(APPROVAL_MODES),
    delegation: z.enum(["allow", "deny"]).optional(),
  }),
});

export function parseDispatchIntent(input: unknown): DispatchIntent {
  const intent = dispatchSchema.parse(input);
  if (intent.request.requesterRef !== intent.attemptId) throw new Error("dispatch requester must match attempt");
  return intent;
}

export interface DispatchIntent {
  goalId: string;
  attemptId: string;
  authorizationRef: string;
  request: ClientRootRequest;
}

export interface ExecutionBudgetStore {
  create(goalId: string, limit: number): void;
  bindRoot(goalId: string, rootId: string): void;
  reserve(goalId: string, assignmentId: string, executionNo: number): "reserved" | "duplicate" | "exhausted";
  admit(rootId: string, assignmentId: string, executionNo: number): boolean;
  prepareDispatch(intent: DispatchIntent): "prepared" | "duplicate";
  pendingDispatches(limit: number): DispatchIntent[];
  pendingDispatch(key: string): DispatchIntent | undefined;
  rootIntent(rootId: string): DispatchIntent | undefined;
  acknowledgeDispatch(key: string, rootId: string): void;
  usage(goalId: string): { limit: number; reserved: number } | undefined;
  close(): void;
}

export function openExecutionBudgetStore(path: string): ExecutionBudgetStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    try { chmodSync(path, 0o600); } catch {}
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const metadataExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_schema_migrations'").get();
  const currentSchema = metadataExists ? Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM goal_schema_migrations").get()?.version) : 0;
  if (currentSchema > GOAL_SCHEMA_VERSION) { db.close(); throw new Error("goals.db schema is newer than this build"); }
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_execution_budgets (
      goal_id TEXT PRIMARY KEY,
      execution_limit INTEGER NOT NULL CHECK(execution_limit >= 0)
    );
    CREATE TABLE IF NOT EXISTS goal_execution_reservations (
      assignment_id TEXT NOT NULL,
      execution_no INTEGER NOT NULL CHECK(execution_no > 0),
      goal_id TEXT NOT NULL REFERENCES goal_execution_budgets(goal_id),
      reserved_at INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, execution_no)
    );
    CREATE TABLE IF NOT EXISTS goal_execution_roots (
      root_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goal_execution_budgets(goal_id)
    );
    CREATE TABLE IF NOT EXISTS goal_dispatch_outbox (
      dispatch_key TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      root_id TEXT NOT NULL UNIQUE,
      goal_id TEXT NOT NULL REFERENCES goal_execution_budgets(goal_id),
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'accepted'))
    );
    CREATE INDEX IF NOT EXISTS goal_execution_reservations_goal ON goal_execution_reservations(goal_id);
  `);
  const insertBudget = db.prepare("INSERT INTO goal_execution_budgets (goal_id, execution_limit) VALUES (?, ?)");
  const findRoot = db.prepare("SELECT goal_id FROM goal_execution_roots WHERE root_id = ?");
  const insertRoot = db.prepare("INSERT INTO goal_execution_roots (root_id, goal_id) VALUES (?, ?) ON CONFLICT(root_id) DO NOTHING");
  const findDispatch = db.prepare("SELECT request_json FROM goal_dispatch_outbox WHERE dispatch_key = ?");
  const insertDispatch = db.prepare("INSERT INTO goal_dispatch_outbox (dispatch_key, attempt_id, root_id, goal_id, request_json, state) VALUES (?, ?, ?, ?, ?, 'pending')");
  const pendingDispatches = db.prepare("SELECT request_json FROM goal_dispatch_outbox WHERE state = 'pending' ORDER BY rowid LIMIT ?");
  const pendingDispatch = db.prepare("SELECT request_json FROM goal_dispatch_outbox WHERE dispatch_key = ? AND state = 'pending'");
  const goalsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'");
  const goalAllowsStart = (goalId: string) => {
    if (!goalsTable.get()) return true;
    const goal = db.prepare("SELECT status FROM goals WHERE id=?").get(goalId);
    return goal?.status === "active" || goal?.status === "planning";
  };
  const acknowledge = db.prepare("UPDATE goal_dispatch_outbox SET state = 'accepted' WHERE dispatch_key = ? AND root_id = ?");
  const findReservation = db.prepare("SELECT goal_id FROM goal_execution_reservations WHERE assignment_id = ? AND execution_no = ?");
  const insertReservation = db.prepare("INSERT INTO goal_execution_reservations (assignment_id, execution_no, goal_id, reserved_at) VALUES (?, ?, ?, ?)");
  const readUsage = db.prepare(`SELECT b.execution_limit, COUNT(r.assignment_id) AS reserved
    FROM goal_execution_budgets b LEFT JOIN goal_execution_reservations r ON r.goal_id = b.goal_id
    WHERE b.goal_id = ? GROUP BY b.goal_id`);
  function scopeBudgetAllows(goalId: string): boolean {
    if (!goalsTable.get()) return true;
    const scope = db.prepare(`SELECT x.owner_id, c.goal_id AS container_id, w.id AS workstream_id, p.period_key AS budget_period, w.kind
      FROM goal_workstreams x JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
      LEFT JOIN work_execution_containers c ON c.goal_id=x.goal_id AND c.owner_id=x.owner_id AND c.workstream_id=x.workstream_id
      LEFT JOIN work_goal_budget_periods p ON p.goal_id=x.goal_id AND p.workstream_id=x.workstream_id
      WHERE x.goal_id=?`).get(goalId);
    if (!scope) return false;
    const global = db.prepare("SELECT execution_limit FROM work_global_budgets WHERE owner_id=?").get(String(scope.owner_id));
    if (!global && (scope.container_id || scope.kind === "ongoing")) return false;
    if (global) {
      const used = db.prepare(`SELECT COUNT(*) AS n FROM goal_execution_reservations r JOIN goal_workstreams x ON x.goal_id=r.goal_id
        WHERE x.owner_id=?`).get(String(scope.owner_id));
      if (Number(used?.n) >= Number(global.execution_limit)) return false;
    }
    if (scope.kind === "ongoing") {
      if (scope.budget_period === null) return false;
      const period = db.prepare("SELECT execution_limit FROM work_period_budgets WHERE workstream_id=? AND period_key=?")
        .get(String(scope.workstream_id), String(scope.budget_period));
      if (!period) return false;
      const used = db.prepare(`SELECT COUNT(*) AS n FROM goal_execution_reservations r JOIN work_goal_budget_periods p ON p.goal_id=r.goal_id
        WHERE p.workstream_id=? AND p.period_key=?`).get(String(scope.workstream_id), String(scope.budget_period));
      if (Number(used?.n) >= Number(period.execution_limit)) return false;
    }
    return true;
  }
  function reserve(goalId: string, assignmentId: string, executionNo: number, allowed: () => boolean = () => true): "reserved" | "duplicate" | "exhausted" {
    if (!goalId || !assignmentId || !Number.isSafeInteger(executionNo) || executionNo < 1) throw new Error("invalid execution reservation");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!allowed()) { db.exec("COMMIT"); return "exhausted"; }
      const old = findReservation.get(assignmentId, executionNo);
      let result: "reserved" | "duplicate" | "exhausted";
      if (old) {
        if (old.goal_id !== goalId) throw new Error("execution reservation belongs to another goal");
        result = "duplicate";
      } else {
        const usage = readUsage.get(goalId);
        if (!usage) throw new Error("execution budget not found");
        if (Number(usage.reserved) >= Number(usage.execution_limit) || !scopeBudgetAllows(goalId)) result = "exhausted";
        else {
          insertReservation.run(assignmentId, executionNo, goalId, Date.now());
          result = "reserved";
        }
      }
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const store: ExecutionBudgetStore = {
    create(goalId, limit) {
      if (!goalId || !Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid execution budget");
      insertBudget.run(goalId, limit);
    },
    bindRoot(goalId, rootId) {
      if (!goalId || !rootId) throw new Error("invalid execution root");
      insertRoot.run(rootId, goalId);
      const row = findRoot.get(rootId);
      if (!row || row.goal_id !== goalId) throw new Error("execution root belongs to another goal");
    },
    reserve(goalId, assignmentId, executionNo) {
      return reserve(goalId, assignmentId, executionNo);
    },
    admit(rootId, assignmentId, executionNo) {
      const root = findRoot.get(rootId);
      if (!root) return false;
      const goalId = String(root.goal_id);
      return reserve(goalId, assignmentId, executionNo, () => {
        if (!goalAllowsStart(goalId)) return false;
        if (!goalsTable.get()) return true;
        if (assignmentId === rootId && executionNo === 1 && !goalScopeActive(db, goalId)) return false;
        const attempt = db.prepare("SELECT id FROM goal_attempts WHERE root_id=? AND goal_id=?").get(rootId, goalId);
        return !attempt || taskInputsCurrent(db, goalId, String(attempt.id));
      }) !== "exhausted";
    },
    prepareDispatch(input) {
      const intent = parseDispatchIntent(input);
      const json = JSON.stringify(intent);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = findDispatch.get(intent.request.dispatchKey);
        if (existing) {
          if (existing.request_json !== json) throw new Error("dispatch key conflict");
          db.exec("COMMIT");
          return "duplicate";
        }
        insertRoot.run(intent.request.rootId, intent.goalId);
        if (findRoot.get(intent.request.rootId)?.goal_id !== intent.goalId) throw new Error("execution root belongs to another goal");
        insertDispatch.run(intent.request.dispatchKey, intent.attemptId, intent.request.rootId, intent.goalId, json);
        db.exec("COMMIT");
        return "prepared";
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    pendingDispatches(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid outbox limit");
      const rows = goalsTable.get()
        ? db.prepare(`SELECT o.request_json FROM goal_dispatch_outbox o JOIN goals g ON g.id=o.goal_id
          JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id
          JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
          JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
          WHERE o.state='pending' AND g.status IN ('active','planning') AND w.status='active' AND a.status='active'
          ORDER BY o.rowid LIMIT ?`).all(limit)
        : pendingDispatches.all(limit);
      return rows.map(row => parseDispatchIntent(JSON.parse(String(row.request_json))));
    },
    pendingDispatch(key) {
      const row = pendingDispatch.get(key);
      if (!row) return undefined;
      const intent = parseDispatchIntent(JSON.parse(String(row.request_json)));
      return goalAllowsStart(intent.goalId) && (!goalsTable.get() || goalScopeActive(db, intent.goalId)) ? intent : undefined;
    },
    rootIntent(rootId) {
      const row = db.prepare("SELECT request_json FROM goal_dispatch_outbox WHERE root_id=?").get(rootId);
      return row ? parseDispatchIntent(JSON.parse(String(row.request_json))) : undefined;
    },
    acknowledgeDispatch(key, rootId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (acknowledge.run(key, rootId).changes !== 1) throw new Error("dispatch not found or root mismatch");
        const hasAttempts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_attempts'").get();
        if (hasAttempts) {
          const attempt = db.prepare("SELECT goal_id, task_id FROM goal_attempts WHERE root_id=? AND status='prepared'").get(rootId);
          if (attempt) {
            db.prepare("UPDATE goal_attempts SET status='queued' WHERE root_id=? AND status='prepared'").run(rootId);
            if (db.prepare("UPDATE goal_tasks SET status='running' WHERE id=? AND status='ready'").run(String(attempt.task_id)).changes !== 1) {
              throw new Error("dispatch task is not ready");
            }
            db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(String(attempt.goal_id));
            db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'work_queued', version, ? FROM goals WHERE id=?")
              .run(Date.now(), String(attempt.goal_id));
          } else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_management_attempts'").get()) {
            const manager = db.prepare("SELECT goal_id FROM goal_management_attempts WHERE root_id=? AND status='prepared'").get(rootId);
            if (manager) {
              db.prepare("UPDATE goal_management_attempts SET status='queued' WHERE root_id=? AND status='prepared'").run(rootId);
              db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(String(manager.goal_id));
              db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'planning_queued', version, ? FROM goals WHERE id=?")
                .run(Date.now(), String(manager.goal_id));
            }
          }
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_review_attempts'").get()) {
          const review = db.prepare("SELECT goal_id FROM goal_review_attempts WHERE root_id=? AND status='prepared'").get(rootId);
          if (review) {
            db.prepare("UPDATE goal_review_attempts SET status='queued' WHERE root_id=? AND status='prepared'").run(rootId);
            db.prepare("UPDATE goals SET version=version+1 WHERE id=?").run(String(review.goal_id));
            db.prepare("INSERT INTO goal_events (goal_id, kind, version, created_at) SELECT id, 'review_queued', version, ? FROM goals WHERE id=?")
              .run(Date.now(), String(review.goal_id));
          }
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    usage(goalId) {
      const row = readUsage.get(goalId);
      return row ? { limit: Number(row.execution_limit), reserved: Number(row.reserved) } : undefined;
    },
    close() { db.close(); },
  };
  return store;
}
