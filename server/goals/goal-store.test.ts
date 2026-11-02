import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { openGoalStore, type GoalPlan } from "./goal-store.ts";
import type { DispatchIntent } from "./execution-budget.ts";
import { deliverDispatch } from "./dispatch-outbox.ts";
import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner } from "../runtime/testing/fake-runner.ts";
import { reconcileRuntimePage } from "./runtime-reconcile.ts";

describe("goal store", () => {
  it("backfills the old paused state and refuses a newer schema without changing its data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-migration-"));
    try {
      const path = join(dir, "goals.db");
      const store = openGoalStore(path);
      store.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 1 });
      store.setPaused({ goalId: "g", ownerId: "owner", commandId: "pause", expectedVersion: 1, paused: true });
      store.close();
      const previous = new DatabaseSync(path);
      previous.exec("DROP TABLE goal_pause_state");
      previous.close();
      const migrated = openGoalStore(path);
      expect(migrated.setPaused({ goalId: "g", ownerId: "owner", commandId: "resume", expectedVersion: 2, paused: false }))
        .toEqual({ goalId: "g", version: 3 });
      expect(migrated.read("g", "owner")?.status).toBe("planning");
      migrated.close();
      const future = new DatabaseSync(path);
      future.prepare("INSERT INTO goal_schema_migrations (version, applied_at) VALUES (99, 1)").run();
      future.close();
      expect(() => openGoalStore(path)).toThrow(/newer than this build/);
      expect(() => openExecutionBudgetStore(path)).toThrow(/newer than this build/);
      const verify = new DatabaseSync(path, { readOnly: true });
      try { expect(verify.prepare("SELECT title FROM goals WHERE id='g'").get()?.title).toBe("Goal"); } finally { verify.close(); }
    } finally { await removeTempDir(dir); }
  });

  it("rolls back initialization when an existing table has an incompatible shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-invalid-schema-"));
    try {
      const path = join(dir, "goals.db");
      const old = new DatabaseSync(path);
      old.exec("CREATE TABLE goal_attempts (id TEXT PRIMARY KEY); INSERT INTO goal_attempts VALUES ('keep')");
      old.close();
      expect(() => openGoalStore(path)).toThrow(/unsupported goal_attempts schema/);
      const verify = new DatabaseSync(path, { readOnly: true });
      try {
        expect(verify.prepare("SELECT id FROM goal_attempts").get()?.id).toBe("keep");
        expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'").get()).toBeUndefined();
      } finally { verify.close(); }
    } finally { await removeTempDir(dir); }
  });

  it("persists an owner-scoped plan and rejects cycles, stale writes and command reuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-store-"));
    try {
      const path = join(dir, "goals.db");
      const store = openGoalStore(path, { unsafeTestPlanBootstrap: true });
      const create = { id: "g", ownerId: "owner", commandId: "create", title: "Build", request: "Make a report",
        leadBotId: "lead", leadThreadId: "thread", executionLimit: 3 };
      expect(store.create(create)).toEqual({ goalId: "g", version: 1 });
      expect(store.create(create)).toEqual({ goalId: "g", version: 1 });
      expect(() => store.create({ ...create, title: "Changed" })).toThrow(/command id conflict/);
      const task = { id: "a", title: "Research", brief: "Collect sources", assigneeBotId: "researcher", required: true,
        workspaceRef: "workspace", criteria: [{ id: "c", description: "Sources exist", required: true,
          kind: "artifact_exists" as const, config: { logicalName: "sources" } }], dependsOn: [] as string[] };
      const plan: GoalPlan = { goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1,
        requirementRevision: 1, sourceAttemptId: "attempt", reason: "initial plan",
        tasks: [task, { ...task, id: "b", title: "Write", dependsOn: ["a"] }] };
      expect(() => store.submitInitialPlanUnchecked({ ...plan, tasks: [{ ...task, dependsOn: ["b"] }, plan.tasks[1]!] })).toThrow(/cyclic/);
      expect(() => store.submitInitialPlanUnchecked({ ...plan, expectedVersion: 0 })).toThrow(/version conflict/);
      expect(() => store.submitInitialPlanUnchecked({ ...plan, ownerId: "other" })).toThrow(/not found/);
      expect(store.submitInitialPlanUnchecked(plan)).toEqual({ goalId: "g", version: 2 });
      expect(store.submitInitialPlanUnchecked(plan)).toEqual({ goalId: "g", version: 2 });
      store.close();
      const reopened = openGoalStore(path);
      const budgets = openExecutionBudgetStore(path);
      try {
        expect(reopened.read("g", "other")).toBeUndefined();
        expect(reopened.read("g", "owner")).toMatchObject({ status: "active", planRevision: 1, version: 2,
          tasks: [{ id: "a", status: "planned" }, { id: "b", dependsOn: ["a"], status: "planned" }] });
        expect(budgets.usage("g")).toEqual({ limit: 3, reserved: 0 });
      } finally { budgets.close(); reopened.close(); }
    } finally { await removeTempDir(dir); }
  });

  it("atomically reserves a ready task, its workspace and dispatch while respecting dependencies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-stage-"));
    const path = join(dir, "goals.db");
    const store = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    try {
      store.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "t", executionLimit: 5 });
      const base = { id: "a", title: "A", brief: "Work", assigneeBotId: "bot", required: true, workspaceRef: "same",
        criteria: [{ id: "c", description: "File exists", required: true, kind: "artifact_exists" as const, config: { logicalName: "result" } }], dependsOn: [] as string[] };
      store.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan-attempt", reason: "initial", tasks: [base, { ...base, id: "b", dependsOn: ["a"] }, { ...base, id: "c" }] });
      const intent = (id: string): DispatchIntent => ({ goalId: "g", attemptId: `attempt-${id}`, authorizationRef: "owner",
        request: { dispatchKey: `key-${id}`, rootId: `root-${id}`, requesterRef: `attempt-${id}`, brief: "Work", level: "ask",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: id } } } });
      const stage = (id: string, version: number) => ({ goalId: "g", ownerId: "owner", commandId: `stage-${id}`,
        taskId: id, expectedVersion: version, intent: intent(id) });
      const resolve = () => "canonical-workspace";
      expect(() => store.prepareWork(stage("b", 2), resolve)).toThrow(/dependencies/);
      expect(store.prepareWork(stage("a", 2), resolve)).toEqual({ goalId: "g", version: 3 });
      expect(store.prepareWork(stage("a", 2), resolve)).toEqual({ goalId: "g", version: 3 });
      expect(() => store.prepareWork(stage("c", 3), resolve)).toThrow(/active writer/);
      expect(store.read("g", "owner")?.tasks.map(task => [task.id, task.status])).toEqual([["a", "ready"], ["b", "planned"], ["c", "planned"]]);
      const budget = openExecutionBudgetStore(path);
      const runtimeStore = openRuntimeStore(":memory:");
      try {
        const runtime = new Runtime(runtimeStore, new FakeRunner(), { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
        runtime.open();
        expect(deliverDispatch("key-a", budget, runtime, () => true)).toMatchObject({ ok: true, assignment: { id: "root-a" } });
        expect(store.read("g", "owner")?.tasks[0]).toMatchObject({ id: "a", status: "running" });
        expect(budget.pendingDispatches(10)).toEqual([]);
        runtime.tick();
        await new Promise<void>(resolve => setImmediate(resolve));
        const root = runtimeStore.get("root-a")!;
        const lastEvent = runtimeStore.events("root-a").at(-1)!;
        expect(root.status).toBe("completed");
        expect(reconcileRuntimePage(store, runtimeStore, 100)).toBeGreaterThan(0);
        expect(store.runtimeCursor()).toBe(lastEvent.id);
        expect(reconcileRuntimePage(store, runtimeStore, 100)).toBe(0);
        expect(store.applyRuntimeTransition(lastEvent.id, root)).toBe("duplicate");
        expect(store.read("g", "owner")?.tasks[0]).toMatchObject({ id: "a", status: "blocked", blocker: "incomplete_output" });
        expect(store.applyRuntimeTransition(lastEvent.id + 1, { ...root, status: "running" })).toBe("ignored");
        expect(store.read("g", "owner")?.tasks[0]).toMatchObject({ id: "a", status: "blocked", blocker: "incomplete_output" });
      } finally { runtimeStore.close(); budget.close(); }
    } finally { store.close(); await removeTempDir(dir); }
  });
});
