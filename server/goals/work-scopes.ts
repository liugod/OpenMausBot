import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(200);
const scopeStatus = z.enum(["active", "paused", "archived"]);

function defaultIds(ownerId: string) {
  const hash = createHash("sha256").update(ownerId).digest("hex");
  return { areaId: `legacy-area:${hash}`, workstreamId: `legacy-workstream:${hash}` };
}

export function migrateWorkScopes(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_areas (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      default_lead_bot_id TEXT, context_revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
      version INTEGER NOT NULL DEFAULT 1, UNIQUE(id, owner_id));
    CREATE TABLE IF NOT EXISTS work_streams (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, area_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('project','ongoing')), name TEXT NOT NULL, context_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('active','paused','completed','archived')), version INTEGER NOT NULL DEFAULT 1,
      CHECK(kind <> 'ongoing' OR status <> 'completed'), UNIQUE(id, owner_id),
      FOREIGN KEY(area_id, owner_id) REFERENCES work_areas(id, owner_id));
    CREATE TABLE IF NOT EXISTS goal_workstreams (goal_id TEXT PRIMARY KEY REFERENCES goals(id), owner_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, FOREIGN KEY(workstream_id, owner_id) REFERENCES work_streams(id, owner_id));
    CREATE TABLE IF NOT EXISTS work_execution_containers (goal_id TEXT PRIMARY KEY REFERENCES goals(id), owner_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, routine_id TEXT, occurrence_key TEXT, budget_period TEXT, request_hash TEXT NOT NULL,
      CHECK ((routine_id IS NULL AND occurrence_key IS NULL) OR (routine_id IS NOT NULL AND occurrence_key IS NOT NULL)),
      UNIQUE(workstream_id, routine_id, occurrence_key), FOREIGN KEY(workstream_id, owner_id) REFERENCES work_streams(id, owner_id));
    CREATE TABLE IF NOT EXISTS work_global_budgets (owner_id TEXT PRIMARY KEY, execution_limit INTEGER NOT NULL CHECK(execution_limit>=0));
    CREATE TABLE IF NOT EXISTS work_period_budgets (workstream_id TEXT NOT NULL REFERENCES work_streams(id), period_key TEXT NOT NULL,
      execution_limit INTEGER NOT NULL CHECK(execution_limit>=0), PRIMARY KEY(workstream_id, period_key));
    CREATE TABLE IF NOT EXISTS work_thread_scopes (thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
      FOREIGN KEY(workstream_id, owner_id) REFERENCES work_streams(id, owner_id));
    CREATE TABLE IF NOT EXISTS work_chat_links (goal_id TEXT PRIMARY KEY REFERENCES goals(id), owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_goal_budget_periods (goal_id TEXT PRIMARY KEY REFERENCES goals(id), workstream_id TEXT NOT NULL,
      period_key TEXT NOT NULL, FOREIGN KEY(workstream_id, period_key) REFERENCES work_period_budgets(workstream_id, period_key));
  `);
  for (const row of db.prepare("SELECT id, owner_id FROM goals WHERE id NOT IN (SELECT goal_id FROM goal_workstreams)").all()) {
    assignDefaultScope(db, String(row.id), String(row.owner_id));
  }
  db.exec(`INSERT OR IGNORE INTO work_goal_budget_periods (goal_id, workstream_id, period_key)
    SELECT c.goal_id, c.workstream_id, c.budget_period FROM work_execution_containers c
    JOIN work_period_budgets p ON p.workstream_id=c.workstream_id AND p.period_key=c.budget_period WHERE c.budget_period IS NOT NULL`);
  if (db.prepare(`SELECT 1 FROM goal_workstreams x LEFT JOIN goals g ON g.id=x.goal_id AND g.owner_id=x.owner_id
    LEFT JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
    LEFT JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
    WHERE g.id IS NULL OR w.id IS NULL OR a.id IS NULL LIMIT 1`).get()) throw new Error("invalid goal work scope association");
}

function ensureDefaultScope(db: DatabaseSync, ownerId: string) {
  const { areaId, workstreamId } = defaultIds(ownerId);
  db.prepare("INSERT OR IGNORE INTO work_areas (id, owner_id, name, status) VALUES (?, ?, '未分类', 'active')").run(areaId, ownerId);
  db.prepare("INSERT OR IGNORE INTO work_streams (id, owner_id, area_id, kind, name, status) VALUES (?, ?, ?, 'project', '兼容工作流', 'active')")
    .run(workstreamId, ownerId, areaId);
  const valid = db.prepare(`SELECT 1 FROM work_streams w JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
    WHERE w.id=? AND w.owner_id=? AND w.area_id=? AND a.owner_id=?`).get(workstreamId, ownerId, areaId, ownerId);
  if (!valid) throw new Error("default work scope collision");
  return { areaId, workstreamId };
}
export function assignDefaultScope(db: DatabaseSync, goalId: string, ownerId: string): void {
  const { workstreamId } = ensureDefaultScope(db, ownerId);
  db.prepare("INSERT INTO goal_workstreams (goal_id, owner_id, workstream_id) VALUES (?, ?, ?)").run(goalId, ownerId, workstreamId);
}

export function goalScopeActive(db: DatabaseSync, goalId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM goal_workstreams x JOIN goals g ON g.id=x.goal_id AND g.owner_id=x.owner_id
    JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
    JOIN work_areas a ON a.id=w.area_id AND a.owner_id=w.owner_id
    WHERE x.goal_id=? AND w.status='active' AND a.status='active'`).get(goalId);
}

export function bindWorkThread(db: DatabaseSync, goalId: string, threadId: string): void {
  const scope = db.prepare("SELECT owner_id, workstream_id FROM goal_workstreams WHERE goal_id=?").get(goalId);
  if (!scope) throw new Error("goal has no workstream");
  db.prepare("INSERT OR IGNORE INTO work_thread_scopes (thread_id, owner_id, workstream_id) VALUES (?, ?, ?)")
    .run(threadId, String(scope.owner_id), String(scope.workstream_id));
  const bound = db.prepare("SELECT owner_id, workstream_id FROM work_thread_scopes WHERE thread_id=?").get(threadId);
  if (!bound || bound.owner_id !== scope.owner_id || bound.workstream_id !== scope.workstream_id) throw new Error("thread is bound to another workstream");
}

export function createWorkScopeApi(db: DatabaseSync) {
  return {
    ensureDefault(ownerId: string) { id.parse(ownerId); return ensureDefaultScope(db, ownerId); },
    ensureGlobalBudget(input: { ownerId: string; limit: number }) {
      const value = z.strictObject({ ownerId: id, limit: z.number().int().nonnegative().safe() }).parse(input);
      db.prepare("INSERT OR IGNORE INTO work_global_budgets (owner_id, execution_limit) VALUES (?, ?)").run(value.ownerId, value.limit);
    },
    createArea(input: { id: string; ownerId: string; name: string; defaultLeadBotId?: string }) {
      const value = z.strictObject({ id, ownerId: id, name, defaultLeadBotId: id.optional() }).parse(input);
      db.prepare("INSERT INTO work_areas (id, owner_id, name, default_lead_bot_id, status) VALUES (?, ?, ?, ?, 'active')")
        .run(value.id, value.ownerId, value.name, value.defaultLeadBotId ?? null);
    },
    createWorkstream(input: { id: string; ownerId: string; areaId: string; name: string; kind: "project" | "ongoing" }) {
      const value = z.strictObject({ id, ownerId: id, areaId: id, name, kind: z.enum(["project", "ongoing"]) }).parse(input);
      if (!db.prepare("SELECT 1 FROM work_areas WHERE id=? AND owner_id=? AND status='active'").get(value.areaId, value.ownerId)) throw new Error("active area not found");
      db.prepare("INSERT INTO work_streams (id, owner_id, area_id, kind, name, status) VALUES (?, ?, ?, ?, ?, 'active')")
        .run(value.id, value.ownerId, value.areaId, value.kind, value.name);
    },
    list(ownerId: string) {
      id.parse(ownerId);
      return { areas: db.prepare("SELECT id, name, status, default_lead_bot_id AS defaultLeadBotId, context_revision AS contextRevision, version FROM work_areas WHERE owner_id=? ORDER BY id").all(ownerId),
        workstreams: db.prepare("SELECT id, area_id AS areaId, name, kind, status, context_revision AS contextRevision, version FROM work_streams WHERE owner_id=? ORDER BY id").all(ownerId) };
    },
    overview(ownerId: string, areaId?: string) {
      id.parse(ownerId);
      if (areaId !== undefined) id.parse(areaId);
      const rows = db.prepare(`SELECT t.id AS task_id, t.status AS task_status, t.task_json, g.id AS goal_id, g.status AS goal_status,
        w.id AS workstream_id, w.area_id, c.goal_id AS container_id, b.code AS blocker, l.thread_id AS source_thread_id
        FROM goal_tasks t JOIN goals g ON g.id=t.goal_id JOIN goal_workstreams x ON x.goal_id=g.id AND x.owner_id=g.owner_id
        JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
        LEFT JOIN work_execution_containers c ON c.goal_id=g.id AND c.owner_id=g.owner_id
        LEFT JOIN goal_task_blockers b ON b.task_id=t.id
        LEFT JOIN work_chat_links l ON l.goal_id=g.id AND l.owner_id=g.owner_id
        WHERE g.owner_id=? AND (? IS NULL OR w.area_id=?) AND t.plan_revision=g.plan_revision
        ORDER BY w.area_id, w.id, t.id`).all(ownerId, areaId ?? null, areaId ?? null);
      return rows.map(row => {
        const task = z.object({ title: z.string(), assigneeBotId: z.string() }).parse(JSON.parse(String(row.task_json)));
        return { taskId: String(row.task_id), title: task.title, assigneeBotId: task.assigneeBotId, status: String(row.task_status), areaId: String(row.area_id),
          workstreamId: String(row.workstream_id), ...(row.container_id ? { itemId: String(row.container_id) } : { goalId: String(row.goal_id) }),
          ...(row.blocker ? { blocker: String(row.blocker) } : {}),
          ...(row.source_thread_id ? { sourceThreadId: String(row.source_thread_id) } : {}) };
      });
    },
    budgets(ownerId: string) {
      id.parse(ownerId);
      const global = db.prepare('SELECT execution_limit AS "limit" FROM work_global_budgets WHERE owner_id=?').get(ownerId);
      const hasReservations = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_execution_reservations'").get();
      const used = hasReservations ? Number(db.prepare(`SELECT COUNT(*) AS used FROM goal_execution_reservations r
        JOIN goal_workstreams x ON x.goal_id=r.goal_id WHERE x.owner_id=?`).get(ownerId)?.used) : 0;
      const usage = hasReservations ? `(SELECT COUNT(*) FROM goal_execution_reservations r JOIN work_goal_budget_periods gp ON gp.goal_id=r.goal_id
        WHERE gp.workstream_id=p.workstream_id AND gp.period_key=p.period_key)` : "0";
      const periods = db.prepare(`SELECT p.workstream_id AS workstreamId, p.period_key AS periodKey, p.execution_limit AS "limit", ${usage} AS used
        FROM work_period_budgets p JOIN work_streams w ON w.id=p.workstream_id WHERE w.owner_id=? ORDER BY p.workstream_id, p.period_key`).all(ownerId);
      return { global: global ? { limit: Number(global.limit), used } : null, periods };
    },
    setGlobalBudget(input: { ownerId: string; limit: number }) {
      const value = z.strictObject({ ownerId: id, limit: z.number().int().nonnegative().safe() }).parse(input);
      db.prepare(`INSERT INTO work_global_budgets (owner_id, execution_limit) VALUES (?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET execution_limit=excluded.execution_limit`).run(value.ownerId, value.limit);
    },
    setPeriodBudget(input: { ownerId: string; workstreamId: string; periodKey: string; limit: number }) {
      const value = z.strictObject({ ownerId: id, workstreamId: id, periodKey: id, limit: z.number().int().nonnegative().safe() }).parse(input);
      if (!db.prepare("SELECT 1 FROM work_streams WHERE id=? AND owner_id=? AND kind='ongoing'").get(value.workstreamId, value.ownerId)) throw new Error("ongoing workstream not found");
      db.prepare(`INSERT INTO work_period_budgets (workstream_id, period_key, execution_limit) VALUES (?, ?, ?)
        ON CONFLICT(workstream_id, period_key) DO UPDATE SET execution_limit=excluded.execution_limit`).run(value.workstreamId, value.periodKey, value.limit);
    },
    update(input: { ownerId: string; id: string; type: "area" | "workstream"; expectedVersion: number; name?: string; status?: "active" | "paused" | "archived" | "completed" }) {
      const value = z.strictObject({ ownerId: id, id, type: z.enum(["area", "workstream"]), expectedVersion: z.number().int().positive(),
        name: name.optional(), status: z.union([scopeStatus, z.literal("completed")]).optional() }).parse(input);
      if (!value.name && !value.status) throw new Error("no scope changes");
      db.exec("BEGIN IMMEDIATE");
      try {
        const table = value.type === "area" ? "work_areas" : "work_streams";
        const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`).get(value.id, value.ownerId);
        if (!row || Number(row.version) !== value.expectedVersion) throw new Error("scope not found or version conflict");
        if (value.type === "area" && value.status === "completed") throw new Error("area cannot be completed");
        if (value.type === "workstream" && row.kind === "ongoing" && value.status === "completed") throw new Error("ongoing workstream cannot be completed");
        if (row.status === "archived" && value.status && value.status !== "archived") throw new Error("archived scope cannot be reactivated");
        if (value.status === "archived") {
          const predicate = value.type === "area" ? "w.area_id=?" : "w.id=?";
          const unresolved = db.prepare(`SELECT 1 FROM goal_workstreams x JOIN work_streams w ON w.id=x.workstream_id AND w.owner_id=x.owner_id
            JOIN goals g ON g.id=x.goal_id AND g.owner_id=x.owner_id WHERE ${predicate} AND w.owner_id=? AND
            (g.status NOT IN ('delivered','cancelled') OR EXISTS (SELECT 1 FROM goal_stop_outbox s WHERE s.goal_id=g.id AND s.state='pending')
             OR EXISTS (SELECT 1 FROM goal_management_stop_outbox s WHERE s.goal_id=g.id AND s.state='pending')
             OR EXISTS (SELECT 1 FROM goal_review_stop_outbox s WHERE s.goal_id=g.id AND s.state='pending')
             OR EXISTS (SELECT 1 FROM goal_attempts a WHERE a.goal_id=g.id AND a.status IN ('prepared','queued','running','waiting','reconciling'))
             OR EXISTS (SELECT 1 FROM goal_management_attempts a WHERE a.goal_id=g.id AND a.status IN ('prepared','queued','running','waiting','reconciling'))
             OR EXISTS (SELECT 1 FROM goal_review_attempts a WHERE a.goal_id=g.id AND a.status IN ('prepared','queued','running','waiting','reconciling'))) LIMIT 1`)
            .get(value.id, value.ownerId);
          if (unresolved) throw new Error("scope has unresolved work");
        }
        db.prepare(`UPDATE ${table} SET name=?, status=?, version=version+1 WHERE id=? AND owner_id=?`)
          .run(value.name ?? String(row.name), value.status ?? String(row.status), value.id, value.ownerId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
