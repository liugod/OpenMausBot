import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, custom } from "../runtime/testing/fake-runner.ts";
import type { RunResult } from "../runtime/types.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { openGoalStore } from "./goal-store.ts";
import { createGoalScheduler } from "./scheduler.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function createTask(goals: ReturnType<typeof openGoalStore>, id: string) {
  goals.create({ id, ownerId: "owner", commandId: `create-${id}`, title: id, request: "Work", leadBotId: "lead", leadThreadId: `lead-${id}`, executionLimit: 4 });
  goals.submitInitialPlanUnchecked({ goalId: id, ownerId: "owner", commandId: `plan-${id}`, expectedVersion: 1, requirementRevision: 1,
    sourceAttemptId: `plan-attempt-${id}`, reason: "initial", tasks: [{ id: `task-${id}`, title: "Task", brief: "Work", assigneeBotId: "bot", required: true,
      workspaceRef: "same-workspace", dependsOn: [], criteria: [{ id: "criterion", description: "Review", kind: "lead_review", required: true, config: {} }] }] });
}

function prepare(goals: ReturnType<typeof openGoalStore>, id: string) {
  return goals.prepareWork({ goalId: id, ownerId: "owner", commandId: `work-${id}`, taskId: `task-${id}`, expectedVersion: goals.read(id, "owner")!.version,
    intent: { goalId: id, attemptId: `attempt-${id}`, authorizationRef: "owner", request: { dispatchKey: `key-${id}`, rootId: `root-${id}`,
      requesterRef: `attempt-${id}`, origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: `thread-${id}` } },
      brief: "Work", level: "ask" } } }, ref => ref);
}

describe("goal cancellation", () => {
  it("retains the workspace until a cancelled turn actually settles, and ignores its late result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-cancel-"));
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    let finish: ((result: RunResult) => void) | undefined;
    runner.script("bot", custom(() => new Promise<RunResult>(resolve => { finish = resolve; })));
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      createTask(goals, "one");
      createTask(goals, "two");
      prepare(goals, "one");
      scheduler.start();
      scheduler.tick();
      await flush();
      expect(runtimeStore.get("root-one")?.status).toBe("running");
      const command = { goalId: "one", ownerId: "owner", commandId: "cancel-one", expectedVersion: goals.read("one", "owner")!.version };
      const result = goals.cancel(command);
      expect(goals.cancel(command)).toEqual(result);
      scheduler.tick();
      expect(runtimeStore.get("root-one")?.status).toBe("cancelled");
      expect(goals.read("one", "owner")).toMatchObject({ status: "cancelled", stopPending: true, tasks: [{ status: "cancelled" }] });
      expect(() => prepare(goals, "two")).toThrow(/active writer/);
      expect(finish).toBeDefined();
      finish!({ kind: "completed", text: "late" });
      await flush();
      scheduler.tick();
      expect(goals.read("one", "owner")).toMatchObject({ status: "cancelled", stopPending: false, tasks: [{ status: "cancelled" }] });
      expect(prepare(goals, "two")).toEqual({ goalId: "two", version: 3 });
      scheduler.tick();
      await flush();
      scheduler.tick();
      expect(goals.read("two", "owner")?.tasks[0]).toMatchObject({ status: "blocked", blocker: "incomplete_output" });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("cancels an unsent outbox request without ever enqueuing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-unsent-stop-"));
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runtime = new Runtime(runtimeStore, new FakeRunner(), { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      createTask(goals, "one");
      prepare(goals, "one");
      goals.cancel({ goalId: "one", ownerId: "owner", commandId: "cancel", expectedVersion: 3 });
      scheduler.start();
      scheduler.tick();
      scheduler.tick();
      expect(runtimeStore.clientRoot("key-one")).toBeUndefined();
      expect(goals.read("one", "owner")).toMatchObject({ status: "cancelled", stopPending: false, tasks: [{ status: "cancelled" }] });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("does not infer stop confirmation from a cancelled row after a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-stop-restart-"));
    const goalPath = join(dir, "goals.db");
    const runtimePath = join(dir, "runtime.db");
    const goals = openGoalStore(goalPath, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(goalPath);
    const runtimeStore = openRuntimeStore(runtimePath);
    const runner = new FakeRunner();
    runner.script("bot", custom(() => new Promise<RunResult>(() => {})));
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    let closed = false;
    try {
      createTask(goals, "one");
      createTask(goals, "two");
      prepare(goals, "one");
      scheduler.start(); scheduler.tick(); await flush();
      goals.cancel({ goalId: "one", ownerId: "owner", commandId: "cancel-one", expectedVersion: goals.read("one", "owner")!.version });
      scheduler.tick();
      expect(runtimeStore.clientStopPending("root-one")).toBe(true);
      expect(runtimeStore.get("root-one")?.status).toBe("cancelled");
      runtime.close(); scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); closed = true;

      const restoredGoals = openGoalStore(goalPath, { unsafeTestPlanBootstrap: true });
      const restoredBudget = openExecutionBudgetStore(goalPath);
      const restoredRuntimeStore = openRuntimeStore(runtimePath);
      const restoredRuntime = new Runtime(restoredRuntimeStore, new FakeRunner(), { admitClientExecution: (root, id, no) => restoredBudget.admit(root, id, no) });
      const restored = createGoalScheduler({ goals: restoredGoals, budget: restoredBudget, runtime: restoredRuntime, runtimeStore: restoredRuntimeStore,
        lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
      try {
        restored.start(); restored.tick(); restored.tick();
        expect(restoredRuntimeStore.clientStopPending("root-one")).toBe(true);
        expect(restoredGoals.read("one", "owner")).toMatchObject({ status: "cancelled", stopPending: true });
        expect(() => prepare(restoredGoals, "two")).toThrow(/active writer/);
        expect(restoredRuntime.confirmClientRootStopped("root-one", () => false)).toBe(false);
        expect(restoredGoals.read("one", "owner")?.stopPending).toBe(true);
        expect(restoredRuntime.confirmClientRootStopped("root-one", () => true)).toBe(true);
        restored.tick();
        expect(restoredGoals.read("one", "owner")).toMatchObject({ status: "cancelled", stopPending: false });
        expect(prepare(restoredGoals, "two")).toEqual({ goalId: "two", version: 3 });
      } finally { restored.close(); restoredRuntimeStore.close(); restoredBudget.close(); restoredGoals.close(); }
    } finally {
      scheduler.close();
      if (!closed) { runtimeStore.close(); budget.close(); goals.close(); }
      await removeTempDir(dir);
    }
  });
});
