import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";

describe("work scope migration and controls", () => {
  it("migrates existing goals without changing their identity, history or budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-scope-migrate-"));
    const path = join(dir, "goals.db");
    try {
      const original = openGoalStore(path);
      original.create({ id: "old", ownerId: "owner", commandId: "create", title: "Old", request: "Keep", leadBotId: "lead", leadThreadId: "thread", executionLimit: 5 });
      original.close();
      const oldBudget = openExecutionBudgetStore(path);
      oldBudget.reserve("old", "old-run", 1);
      oldBudget.close();
      const legacy = new DatabaseSync(path);
      legacy.exec("PRAGMA foreign_keys=OFF; DROP TABLE goal_workstreams; DROP TABLE work_streams; DROP TABLE work_areas; DELETE FROM goal_schema_migrations WHERE version=2;");
      legacy.close();
      const migrated = openGoalStore(path);
      const budget = openExecutionBudgetStore(path);
      try {
        expect(migrated.read("old", "owner")).toMatchObject({ id: "old", status: "planning", version: 1, areaId: expect.stringMatching(/^legacy-area:/), workstreamId: expect.stringMatching(/^legacy-workstream:/) });
        expect(budget.usage("old")).toEqual({ limit: 5, reserved: 1 });
        expect(migrated.scopes.list("owner").areas).toHaveLength(1);
        expect(migrated.scopes.list("other").areas).toHaveLength(0);
      } finally { budget.close(); migrated.close(); }
      const again = openGoalStore(path);
      try { expect(again.scopes.list("owner").workstreams).toHaveLength(1); } finally { again.close(); }
    } finally { await removeTempDir(dir); }
  });

  it("keeps owner and parent controls separate and prevents unsafe archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-scope-control-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(path);
    try {
      goals.scopes.createArea({ id: "a", ownerId: "owner", name: "Product" });
      goals.scopes.createArea({ id: "b", ownerId: "owner", name: "Research" });
      goals.scopes.createWorkstream({ id: "project", ownerId: "owner", areaId: "a", name: "Project", kind: "project" });
      goals.scopes.createWorkstream({ id: "ongoing", ownerId: "owner", areaId: "b", name: "Brief", kind: "ongoing" });
      expect(() => goals.scopes.createWorkstream({ id: "bad", ownerId: "other", areaId: "a", name: "Bad", kind: "project" })).toThrow();
      expect(() => goals.scopes.update({ id: "ongoing", ownerId: "owner", type: "workstream", expectedVersion: 1, status: "completed" })).toThrow();
      const create = { id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 2 };
      expect(() => goals.create({ ...create, ownerId: "other", workstreamId: "project" })).toThrow();
      goals.create({ ...create, workstreamId: "project" });
      goals.create({ ...create, id: "g2", commandId: "create-2", workstreamId: "ongoing" });
      for (const goalId of ["g", "g2"]) {
        goals.submitInitialPlanUnchecked({ goalId, ownerId: "owner", commandId: `plan-${goalId}`, expectedVersion: 1,
          requirementRevision: 1, sourceAttemptId: `plan-${goalId}`, reason: "test", tasks: [{ id: `task-${goalId}`, title: "Task", brief: "Work",
            assigneeBotId: "worker", required: true, workspaceRef: `workspace-${goalId}`, dependsOn: [],
            criteria: [{ id: `criterion-${goalId}`, description: "File", kind: "artifact_exists", required: true, config: { logicalName: "result" } }] }] });
      }
      budget.bindRoot("g", "root");
      budget.prepareDispatch({ goalId: "g", attemptId: "attempt", authorizationRef: "owner", request: { dispatchKey: "dispatch", rootId: "root",
        requesterRef: "attempt", origin: { kind: "person", source: "chat" }, assignee: { botId: "worker",
          destination: { kind: "work_thread", threadId: "work" } }, brief: "Work", level: "ask" } });
      expect(budget.pendingDispatches(10)).toHaveLength(1);
      expect(() => goals.scopes.update({ id: "a", ownerId: "owner", type: "area", expectedVersion: 1, status: "archived" })).toThrow(/unresolved/);
      goals.scopes.update({ id: "project", ownerId: "owner", type: "workstream", expectedVersion: 1, status: "paused" });
      goals.scopes.update({ id: "a", ownerId: "owner", type: "area", expectedVersion: 1, status: "paused" });
      expect(budget.admit("root", "root", 1)).toBe(false);
      expect(budget.pendingDispatches(10)).toHaveLength(0);
      expect(goals.readyWork("", "", 10).map(item => item.goalId)).toEqual(["g2"]);
      goals.scopes.update({ id: "a", ownerId: "owner", type: "area", expectedVersion: 2, status: "active" });
      expect(budget.admit("root", "root", 1)).toBe(false);
      expect(goals.scopes.list("owner").workstreams).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ongoing", status: "active" })]));
      goals.scopes.update({ id: "project", ownerId: "owner", type: "workstream", expectedVersion: 2, status: "active" });
      goals.scopes.setGlobalBudget({ ownerId: "owner", limit: 10 });
      expect(budget.admit("root", "root", 1)).toBe(true);
      expect(goals.scopes.budgets("owner").global).toEqual({ limit: 10, used: 1 });
      expect(goals.scopes.budgets("other")).toEqual({ global: null, periods: [] });
      expect(budget.pendingDispatches(10)).toHaveLength(1);
      expect(goals.readyWork("", "", 10).map(item => item.goalId)).toEqual(["g", "g2"]);
    } finally { budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("refuses reuse of a work thread across workstreams after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-scope-thread-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    try {
      goals.scopes.createArea({ id: "area", ownerId: "owner", name: "Area" });
      for (const stream of ["one", "two"]) goals.scopes.createWorkstream({ id: stream, ownerId: "owner", areaId: "area", name: stream, kind: "project" });
      for (const stream of ["one", "two"]) {
        goals.create({ id: stream, ownerId: "owner", commandId: `create-${stream}`, title: stream, request: "Work", leadBotId: "lead",
          leadThreadId: `lead-${stream}`, executionLimit: 3, workstreamId: stream });
        goals.submitInitialPlanUnchecked({ goalId: stream, ownerId: "owner", commandId: `plan-${stream}`, expectedVersion: 1, requirementRevision: 1,
          sourceAttemptId: "planning", reason: "test", tasks: [{ id: `task-${stream}`, title: "Task", brief: "Work", assigneeBotId: "bot", required: true,
            workspaceRef: stream, dependsOn: [], criteria: [{ id: `criterion-${stream}`, description: "File", kind: "artifact_exists", required: true, config: { logicalName: "file" } }] }] });
      }
      const intent = (stream: string) => ({ goalId: stream, attemptId: `attempt-${stream}`, authorizationRef: "owner", request: { dispatchKey: `key-${stream}`,
        rootId: `root-${stream}`, requesterRef: `attempt-${stream}`, origin: { kind: "person" as const, source: "chat" as const },
        assignee: { botId: "bot", destination: { kind: "work_thread" as const, threadId: "shared-thread" } }, brief: "Work", level: "ask" as const } });
      goals.prepareWork({ goalId: "one", ownerId: "owner", commandId: "work-one", taskId: "task-one", expectedVersion: 2, intent: intent("one") }, ref => ref);
      goals.close();
      const reopened = openGoalStore(path);
      try {
        expect(() => reopened.prepareWork({ goalId: "two", ownerId: "owner", commandId: "work-two", taskId: "task-two", expectedVersion: 2,
          intent: intent("two") }, ref => ref)).toThrow(/thread is bound to another workstream/);
        expect(reopened.read("two", "owner")?.tasks[0]).toMatchObject({ status: "planned" });
      } finally { reopened.close(); }
    } finally { try { goals.close(); } catch {} await removeTempDir(dir); }
  });
});
