import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, hang, needsInput } from "../runtime/testing/fake-runner.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { openGoalStore } from "./goal-store.ts";
import { createGoalScheduler } from "./scheduler.ts";

describe("goal scheduler", () => {
  it("gives another workstream a turn even when the first has over 100 ready items", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-stream-fairness-"));
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runtime = new Runtime(runtimeStore, new FakeRunner(), { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const visited: string[] = [];
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {},
      prepareReadyWork: candidate => { visited.push(candidate.goalId); return undefined; } });
    try {
      goals.scopes.createArea({ id: "area", ownerId: "owner", name: "Area" });
      for (const stream of ["a", "b"]) goals.scopes.createWorkstream({ id: stream, ownerId: "owner", areaId: "area", name: stream, kind: "project" });
      for (const stream of ["a", "b"]) {
        goals.create({ id: stream, ownerId: "owner", commandId: `create-${stream}`, title: stream, request: "Work", leadBotId: "lead",
          leadThreadId: `lead-${stream}`, executionLimit: 4, workstreamId: stream });
        const count = stream === "a" ? 101 : 1;
        goals.submitInitialPlanUnchecked({ goalId: stream, ownerId: "owner", commandId: `plan-${stream}`, expectedVersion: 1,
          requirementRevision: 1, sourceAttemptId: "plan", reason: "test", tasks: Array.from({ length: count }, (_, n) => ({
            id: `${stream}-${String(n).padStart(3, "0")}`, title: "Task", brief: "Work", assigneeBotId: "bot", required: true,
            workspaceRef: `${stream}-${n}`, dependsOn: [], criteria: [{ id: "file", description: "File", required: true,
              kind: "artifact_exists" as const, config: { logicalName: "file" } }] })) });
      }
      scheduler.start(); scheduler.tick();
      expect(visited.filter(id => id === "a")).toHaveLength(100);
      expect(visited).toContain("b");
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("requires ownership and authorization, and blocks a completed run with no result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-scheduler-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(path);
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    let authorized = false;
    const deps = { goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"),
      authorize: () => authorized ? true as const : "not authorized", log: () => {} };
    const scheduler = createGoalScheduler(deps);
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 2 });
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "initial", tasks: [{ id: "t", title: "Task", brief: "Work", assigneeBotId: "bot", required: true,
          workspaceRef: "workspace", dependsOn: [], criteria: [{ id: "c", description: "Review", kind: "lead_review", required: true, config: {} }] }] });
      goals.prepareWork({ goalId: "g", ownerId: "owner", commandId: "work", taskId: "t", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "a", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "a",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Work", level: "ask" } } }, ref => ref);
      scheduler.start();
      expect(() => createGoalScheduler(deps).start()).toThrow(/cannot acquire/);
      scheduler.tick();
      expect(runtimeStore.get("root")).toBeUndefined();
      authorized = true;
      goals.setPaused({ ownerId: "owner", commandId: "pause", goalId: "g", expectedVersion: 3, paused: true });
      scheduler.tick();
      expect(runtimeStore.get("root")).toBeUndefined();
      expect(budget.pendingDispatches(10)).toEqual([]);
      goals.setPaused({ ownerId: "owner", commandId: "resume", goalId: "g", expectedVersion: 4, paused: false });
      runner.setCanStart("bot", false);
      scheduler.tick();
      expect(runtimeStore.get("root")?.status).toBe("queued");
      goals.setPaused({ ownerId: "owner", commandId: "pause-queued", goalId: "g", expectedVersion: goals.read("g", "owner")!.version, paused: true });
      runner.setCanStart("bot", true);
      scheduler.tick();
      expect(runtimeStore.get("root")?.status).toBe("queued");
      expect(runner.runs()).toHaveLength(0);
      goals.setPaused({ ownerId: "owner", commandId: "resume-queued", goalId: "g", expectedVersion: goals.read("g", "owner")!.version, paused: false });
      scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(goals.read("g", "owner")?.tasks[0]).toMatchObject({ status: "blocked", blocker: "incomplete_output" });
      expect(budget.usage("g")).toEqual({ limit: 2, reserved: 1 });
    } finally {
      scheduler.close(); runtimeStore.close(); budget.close(); goals.close();
      await removeTempDir(dir);
    }
  });

  it("retains the workspace and exposes a blocked task after an interrupted execution is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-cut-"));
    const goalPath = join(dir, "goals.db");
    const runtimePath = join(dir, "runtime.db");
    const goals = openGoalStore(goalPath, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(goalPath);
    const runtimeStore = openRuntimeStore(runtimePath);
    const runner = new FakeRunner();
    runner.script("bot", hang());
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    let firstClosed = false;
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 4 });
      const task = { id: "t", title: "Task", brief: "Work", assigneeBotId: "bot", required: true, workspaceRef: "workspace", dependsOn: [] as string[],
        criteria: [{ id: "c", description: "Review", kind: "lead_review" as const, required: true, config: {} }] };
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "initial", tasks: [task, { ...task, id: "other" }] });
      const intent = (id: string) => ({ goalId: "g", attemptId: `attempt-${id}`, authorizationRef: "owner", request: { dispatchKey: `key-${id}`,
        rootId: `root-${id}`, requesterRef: `attempt-${id}`, origin: { kind: "person" as const, source: "chat" as const },
        assignee: { botId: "bot", destination: { kind: "work_thread" as const, threadId: `thread-${id}` } }, brief: "Work", level: "ask" as const } });
      goals.prepareWork({ goalId: "g", ownerId: "owner", commandId: "work", taskId: "t", expectedVersion: 2, intent: intent("t") }, ref => ref);
      scheduler.start();
      scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtimeStore.get("root-t")?.status).toBe("running");
      runtime.close();
      scheduler.close();
      runtimeStore.close();
      budget.close();
      goals.close();
      firstClosed = true;

      const restoredGoals = openGoalStore(goalPath);
      const restoredBudget = openExecutionBudgetStore(goalPath);
      const restoredRuntimeStore = openRuntimeStore(runtimePath);
      const restoredRunner = new FakeRunner();
      const restoredRuntime = new Runtime(restoredRuntimeStore, restoredRunner, { admitClientExecution: (root, id, no) => restoredBudget.admit(root, id, no) });
      const restored = createGoalScheduler({ goals: restoredGoals, budget: restoredBudget, runtime: restoredRuntime, runtimeStore: restoredRuntimeStore,
        lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
      try {
        restored.start();
        restored.tick();
        expect(restoredRuntimeStore.clientRootHeld("root-t")).toBe(true);
        expect(restoredGoals.read("g", "owner")?.tasks[0]).toMatchObject({ status: "blocked" });
        expect(restoredRunner.runs()).toHaveLength(0);
        expect(restoredBudget.usage("g")).toEqual({ limit: 4, reserved: 1 });
        expect(() => restoredGoals.prepareWork({ goalId: "g", ownerId: "owner", commandId: "other", taskId: "other",
          expectedVersion: restoredGoals.read("g", "owner")!.version, intent: intent("other") }, ref => ref)).toThrow(/active writer/);
      } finally { restored.close(); restoredRuntimeStore.close(); restoredBudget.close(); restoredGoals.close(); }
    } finally {
      scheduler.close();
      if (!firstClosed) { runtimeStore.close(); budget.close(); goals.close(); }
      await removeTempDir(dir);
    }
  });

  it("keeps an independent branch runnable while another waits for the user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-branch-wait-"));
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    runner.script("asker", needsInput("Which region?"));
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 4 });
      const task = { id: "a", title: "A", brief: "Work", assigneeBotId: "asker", required: true, workspaceRef: "workspace-a", dependsOn: [] as string[],
        criteria: [{ id: "c", description: "Review", kind: "lead_review" as const, required: true, config: {} }] };
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "initial", tasks: [task, { ...task, id: "b", title: "B", assigneeBotId: "worker", workspaceRef: "workspace-b" }] });
      const stage = (id: string, botId: string) => goals.prepareWork({ goalId: "g", ownerId: "owner", commandId: `work-${id}`, taskId: id,
        expectedVersion: goals.read("g", "owner")!.version, intent: { goalId: "g", attemptId: `attempt-${id}`, authorizationRef: "owner",
          request: { dispatchKey: `key-${id}`, rootId: `root-${id}`, requesterRef: `attempt-${id}`, origin: { kind: "person", source: "chat" },
            assignee: { botId, destination: { kind: "work_thread", threadId: `thread-${id}` } }, brief: "Work", level: "ask" } } }, ref => ref);
      stage("a", "asker");
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "active", tasks: [{ id: "a", status: "waiting_user" }, { id: "b", status: "planned" }] });
      stage("b", "worker");
      scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(runner.runs().map(call => call.id)).toEqual(["root-a", "root-b"]);
      expect(goals.read("g", "owner")).toMatchObject({ tasks: [{ id: "a", status: "waiting_user" }, { id: "b", status: "blocked", blocker: "incomplete_output" }] });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("automatically prepares ready tasks fairly when the host supplies authorized dispatch context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-auto-work-"));
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    let firstAvailable = false;
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {},
      prepareReadyWork: candidate => {
        if (candidate.goalId === "a" && !firstAvailable) return undefined;
        const goal = candidate.goalId;
        return { intent: { goalId: goal, attemptId: `attempt-${goal}`, authorizationRef: "owner", request: {
          dispatchKey: `key-${goal}`, rootId: `root-${goal}`, requesterRef: `attempt-${goal}`, origin: { kind: "person", source: "chat" },
          assignee: { botId: candidate.task.assigneeBotId, destination: { kind: "work_thread", threadId: `thread-${goal}` } },
          brief: candidate.task.brief, level: "ask" } }, resolveWritableWorkspace: ref => ref };
      } });
    try {
      for (const id of ["a", "b"]) {
        goals.create({ id, ownerId: "owner", commandId: `create-${id}`, title: id, request: "Work", leadBotId: "lead", leadThreadId: `lead-${id}`, executionLimit: 4 });
        goals.submitInitialPlanUnchecked({ goalId: id, ownerId: "owner", commandId: `plan-${id}`, expectedVersion: 1, requirementRevision: 1,
          sourceAttemptId: "plan", reason: "initial", tasks: [{ id: `task-${id}`, title: "Task", brief: "Work", assigneeBotId: `bot-${id}`,
            required: true, workspaceRef: `workspace-${id}`, dependsOn: [], criteria: [{ id: "c", description: "Review", kind: "lead_review", required: true, config: {} }] }] });
      }
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runner.runs().map(call => call.id)).toEqual(["root-b"]);
      expect(goals.read("a", "owner")?.tasks[0]).toMatchObject({ status: "planned" });
      firstAvailable = true;
      scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(runner.runs().map(call => call.id)).toEqual(["root-b", "root-a"]);
      expect(goals.read("a", "owner")?.tasks[0]).toMatchObject({ status: "blocked", blocker: "incomplete_output" });
      expect(goals.read("b", "owner")?.tasks[0]).toMatchObject({ status: "blocked", blocker: "incomplete_output" });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("tries another ready task in the same goal when the first cannot be prepared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-ready-siblings-"));
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {},
      prepareReadyWork: candidate => candidate.task.id === "a" ? undefined : ({ intent: { goalId: "g", attemptId: "attempt-b", authorizationRef: "owner",
        request: { dispatchKey: "key-b", rootId: "root-b", requesterRef: "attempt-b", origin: { kind: "person", source: "chat" },
          assignee: { botId: "worker", destination: { kind: "work_thread", threadId: "thread-b" } }, brief: candidate.task.brief, level: "ask" } },
        resolveWritableWorkspace: ref => ref }) });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 3 });
      const task = { id: "a", title: "A", brief: "Work", assigneeBotId: "worker", required: true, workspaceRef: "workspace-a", dependsOn: [] as string[],
        criteria: [{ id: "c", description: "Review", kind: "lead_review" as const, required: true, config: {} }] };
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "initial", tasks: [task, { ...task, id: "b", title: "B", workspaceRef: "workspace-b" }] });
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runner.runs().map(call => call.id)).toEqual(["root-b"]);
      expect(goals.read("g", "owner")?.tasks[0]).toMatchObject({ id: "a", status: "planned" });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });
});
