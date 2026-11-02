import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, custom, needsInput } from "../runtime/testing/fake-runner.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { openGoalStore, type GoalPlan, type GoalRunContext } from "./goal-store.ts";
import { createGoalScheduler } from "./scheduler.ts";
import { createPlanningTools } from "./planning-tools.ts";
import { parseGoalWorkspaceRef } from "./workspace-refs.ts";

describe("goal planning", () => {
  it("accepts a plan only from its bound live lead, then waits for that run to finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-plan-"));
    const goals = openGoalStore(join(dir, "goals.db"));
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    runner.attach(runtime);
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 4 });
      const intent = { goalId: "g", attemptId: "plan-attempt", authorizationRef: "owner", request: { dispatchKey: "plan-key", rootId: "plan-root",
        requesterRef: "plan-attempt", origin: { kind: "person" as const, source: "chat" as const },
        assignee: { botId: "lead", destination: { kind: "work_thread" as const, threadId: "lead-thread" } }, brief: "Plan", level: "ask" as const, delegation: "deny" as const } };
      const prepare = { goalId: "g", ownerId: "owner", commandId: "prepare-plan", expectedVersion: 1, intent };
      expect(() => goals.preparePlanning({ ...prepare, intent: { ...intent, request: { ...intent.request, delegation: "allow" } } })).toThrow(/invalid planning/);
      expect(goals.preparePlanning(prepare)).toEqual({ goalId: "g", version: 2 });
      expect(goals.preparePlanning(prepare)).toEqual({ goalId: "g", version: 2 });
      let submitted = false;
      runner.script("lead", custom(({ a, handOut }) => {
        const handoff = handOut({ assignee: { botId: "worker", destination: { kind: "work_thread", threadId: "worker-thread" } }, brief: "Bypass" });
        expect(handoff).toMatchObject({ ok: false, reason: /cannot delegate/ });
        const context: GoalRunContext = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
        const live = (candidate: GoalRunContext) => {
          const root = runtimeStore.get(candidate.rootId);
          return root?.status === "running" && root.executions === candidate.executionNo && root.assignee.botId === candidate.botId &&
            root.assignee.destination.threadId === candidate.threadId;
        };
        const plan: GoalPlan = { goalId: "g", ownerId: "owner", commandId: "submit-plan", expectedVersion: goals.read("g", "owner")!.version,
          requirementRevision: 1, sourceAttemptId: "plan-attempt", reason: "initial", tasks: [{ id: "task", title: "Task", brief: "Work",
            assigneeBotId: "worker", required: true, workspaceRef: "workspace", dependsOn: [], criteria: [{ id: "c", description: "Review",
              kind: "lead_review", required: true, config: {} }] }] };
        expect(() => goals.submitPlanFromRun(plan, { ...context, botId: "other" }, live)).toThrow(/not authorized/);
        expect(() => goals.submitPlanFromRun(plan, context, () => false)).toThrow(/not authorized/);
        expect(() => goals.submitInitialPlanUnchecked(plan)).toThrow(/disabled/);
        const tools = createPlanningTools({ goals, context, isCurrentRun: live, canAssignBot: id => id === "worker", canUseWorkspace: ref => ref === "workspace" });
        const snapshot = tools.getGoalContext();
        expect(snapshot).toMatchObject({ goalId: "g", requirementRevision: 1, request: "Work" });
        expect(snapshot).not.toHaveProperty("ownerId");
        expect(() => tools.workspaceForTask({ taskId: "task" })).toThrow(/workspace/);
        const scopedTools = createPlanningTools({ goals, context, isCurrentRun: live, canAssignBot: () => true,
          canUseWorkspace: ref => parseGoalWorkspaceRef(ref)?.workstreamId === snapshot.workstreamId });
        expect(parseGoalWorkspaceRef(scopedTools.workspaceForTask({ taskId: "task" }).workspaceRef))
          .toEqual({ workstreamId: snapshot.workstreamId, taskId: "task" });
        expect(() => scopedTools.workspaceForTask({ taskId: "task", workstreamId: "other" })).toThrow();
        const args = { commandId: plan.commandId, expectedVersion: plan.expectedVersion, requirementRevision: plan.requirementRevision,
          reason: plan.reason, tasks: plan.tasks };
        expect(() => tools.submitPlan({ ...args, goalId: "another-goal" })).toThrow();
        expect(() => tools.submitPlan({ ...args, tasks: [{ ...plan.tasks[0], assigneeBotId: "unknown" }] })).toThrow(/assignee/);
        expect(() => tools.submitPlan({ ...args, tasks: [{ ...plan.tasks[0], workspaceRef: "outside" }] })).toThrow(/workspace/);
        tools.submitPlan(args);
        expect(goals.read("g", "owner")).toMatchObject({ status: "planning", planRevision: 1, tasks: [{ status: "planned" }] });
        submitted = true;
        return { kind: "completed", text: "plan submitted" };
      }));
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(submitted).toBe(true);
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "active", managementAttempts: [{ id: "plan-attempt", kind: "plan", status: "succeeded" }] });
      expect(budget.usage("g")).toEqual({ limit: 4, reserved: 1 });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("blocks a finished planning run that never submitted a structured plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-plan-missing-"));
    const goals = openGoalStore(join(dir, "goals.db"));
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runtime = new Runtime(runtimeStore, new FakeRunner(), { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 4 });
      goals.preparePlanning({ goalId: "g", ownerId: "owner", commandId: "prepare", expectedVersion: 1,
        intent: { goalId: "g", attemptId: "plan", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "plan",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "lead", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Plan", level: "ask", delegation: "deny" } } });
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "blocked", planRevision: 0, tasks: [],
        managementAttempts: [{ status: "succeeded" }] });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("cancels an unsent planning attempt without creating a runtime root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-plan-cancel-"));
    const goals = openGoalStore(join(dir, "goals.db"));
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runtime = new Runtime(runtimeStore, new FakeRunner(), { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 4 });
      goals.preparePlanning({ goalId: "g", ownerId: "owner", commandId: "prepare", expectedVersion: 1,
        intent: { goalId: "g", attemptId: "plan", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "plan",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "lead", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Plan", level: "ask", delegation: "deny" } } });
      goals.cancel({ goalId: "g", ownerId: "owner", commandId: "cancel", expectedVersion: 2 });
      expect(goals.read("g", "owner")?.stopPending).toBe(true);
      scheduler.start(); scheduler.tick();
      expect(runtimeStore.clientRoot("key")).toBeUndefined();
      expect(goals.read("g", "owner")).toMatchObject({ status: "cancelled", stopPending: false, managementAttempts: [{ status: "cancelled" }] });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("returns a planning run to the same attempt after a real user answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-plan-answer-"));
    const goals = openGoalStore(join(dir, "goals.db"));
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 4 });
      goals.preparePlanning({ goalId: "g", ownerId: "owner", commandId: "prepare", expectedVersion: 1,
        intent: { goalId: "g", attemptId: "plan", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "plan",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "lead", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Plan", level: "ask", delegation: "deny" } } });
      runner.script("lead", needsInput("Which region?"), custom(({ a, input }) => {
        expect(input.answer).toBe("EU");
        const context = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
        goals.submitPlanFromRun({ goalId: "g", ownerId: "owner", commandId: "plan-result", expectedVersion: goals.read("g", "owner")!.version,
          requirementRevision: 1, sourceAttemptId: "plan", reason: "initial", tasks: [{ id: "task", title: "Task", brief: "Work", assigneeBotId: "worker",
            required: true, workspaceRef: "work", dependsOn: [], criteria: [{ id: "c", description: "Review", kind: "lead_review", required: true, config: {} }] }] },
        context, candidate => runtimeStore.get(candidate.rootId)?.executions === candidate.executionNo && runtimeStore.get(candidate.rootId)?.status === "running");
        return { kind: "completed", text: "submitted" };
      }));
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "waiting_user", managementAttempts: [{ id: "plan", status: "waiting" }] });
      goals.setPaused({ goalId: "g", ownerId: "owner", commandId: "pause-wait", expectedVersion: goals.read("g", "owner")!.version, paused: true });
      expect(runtime.answer("root", "EU")).toBe(true);
      scheduler.tick();
      expect(runtimeStore.get("root")).toMatchObject({ status: "queued", executions: 1 });
      expect(goals.read("g", "owner")?.status).toBe("paused");
      goals.setPaused({ goalId: "g", ownerId: "owner", commandId: "resume-wait", expectedVersion: goals.read("g", "owner")!.version, paused: false });
      scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "active", managementAttempts: [{ id: "plan", status: "succeeded" }] });
      expect(runtimeStore.all().filter(row => row.rootId === "root")).toHaveLength(1);
      expect(budget.usage("g")).toEqual({ limit: 4, reserved: 2 });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("records an already-running plan while paused but waits for resume before activating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-plan-paused-"));
    const goals = openGoalStore(join(dir, "goals.db"));
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    let notifyStarted!: () => void;
    let continueWork!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const release = new Promise<void>(resolve => { continueWork = resolve; });
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    let error: unknown;
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 4 });
      goals.preparePlanning({ goalId: "g", ownerId: "owner", commandId: "prepare", expectedVersion: 1,
        intent: { goalId: "g", attemptId: "plan", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "plan",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "lead", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Plan", level: "ask", delegation: "deny" } } });
      runner.script("lead", custom(async ({ a }) => {
        try {
          notifyStarted();
          await release;
          const context = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
          const tools = createPlanningTools({ goals, context, isCurrentRun: c => runtimeStore.get(c.rootId)?.status === "running" &&
            runtimeStore.get(c.rootId)?.executions === c.executionNo, canAssignBot: () => true, canUseWorkspace: () => true });
          const snapshot = tools.getGoalContext();
          tools.submitPlan({ commandId: "plan-result", expectedVersion: snapshot.version, requirementRevision: 1, reason: "initial",
            tasks: [{ id: "task", title: "Task", brief: "Work", assigneeBotId: "worker", required: true, workspaceRef: "work", dependsOn: [],
              criteria: [{ id: "c", description: "Review", kind: "lead_review", required: true, config: {} }] }] });
        } catch (caught) { error = caught; throw caught; } finally { finished(); }
        return { kind: "completed", text: "submitted" };
      }));
      scheduler.start(); scheduler.tick(); await started;
      goals.setPaused({ goalId: "g", ownerId: "owner", commandId: "pause", expectedVersion: goals.read("g", "owner")!.version, paused: true });
      continueWork(); await done;
      await new Promise<void>(resolve => setImmediate(resolve));
      if (error) throw error;
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "paused", planRevision: 1, managementAttempts: [{ status: "succeeded" }] });
      goals.setPaused({ goalId: "g", ownerId: "owner", commandId: "resume", expectedVersion: goals.read("g", "owner")!.version, paused: false });
      expect(goals.read("g", "owner")).toMatchObject({ status: "active", tasks: [{ status: "planned" }] });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });
});
