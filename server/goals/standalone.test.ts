import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { openGoalStore } from "./goal-store.ts";
import { createWorkTools } from "./work-tools.ts";
import { createReviewTools } from "./review-tools.ts";
import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, custom } from "../runtime/testing/fake-runner.ts";
import { createGoalScheduler } from "./scheduler.ts";

describe("standalone work items", () => {
  it("deduplicates occurrences across restarts and cannot reset shared budgets with new items", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-work-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path);
    const task = { id: "task-1", title: "Brief", brief: "Prepare a brief", assigneeBotId: "bot", required: true, workspaceRef: "ws",
      dependsOn: [] as string[], criteria: [{ id: "file", description: "Brief exists", kind: "artifact_exists" as const, required: true, config: { logicalName: "brief" } }] };
    const create = { containerId: "internal-1", ownerId: "owner", commandId: "create-1", workstreamId: "stream", leadThreadId: "thread-1",
      executionLimit: 10, budgetPeriod: "2026-W45", routineId: "weekly", occurrenceKey: "2026-W45", sourceThreadId: "source-chat", task };
    try {
      goals.scopes.createArea({ id: "area", ownerId: "owner", name: "Research" });
      goals.scopes.createWorkstream({ id: "stream", ownerId: "owner", areaId: "area", kind: "ongoing", name: "Briefs" });
      expect(() => goals.createStandalone(create)).toThrow(/global execution budget/);
      goals.scopes.setGlobalBudget({ ownerId: "owner", limit: 3 });
      expect(() => goals.createStandalone(create)).toThrow(/period budget/);
      goals.scopes.setPeriodBudget({ ownerId: "owner", workstreamId: "stream", periodKey: "2026-W45", limit: 2 });
      expect(goals.createStandalone(create)).toEqual({ goalId: "internal-1", version: 2 });
      expect(goals.readStandalone("internal-1", "owner")).toMatchObject({ workstreamId: "stream", task: { id: "task-1", status: "planned" } });
      expect(goals.readStandalone("internal-1", "other")).toBeUndefined();
      expect(goals.scopes.overview("owner", "area")).toEqual([expect.objectContaining({ taskId: "task-1", itemId: "internal-1", sourceThreadId: "source-chat", areaId: "area", workstreamId: "stream" })]);
      expect(goals.scopes.overview("owner", "area")[0]).not.toHaveProperty("goalId");
      expect(goals.scopes.overview("other")).toEqual([]);
      expect(goals.scopes.overview("owner", "unknown-area")).toEqual([]);
      expect(goals.createStandalone({ ...create, containerId: "ignored", commandId: "duplicate", task: { ...task, id: "ignored-task" } }))
        .toEqual({ goalId: "internal-1", version: 2 });
      expect(() => goals.createStandalone({ ...create, commandId: "conflict", task: { ...task, brief: "Changed" } })).toThrow(/occurrence key conflict/);
      goals.createStandalone({ ...create, containerId: "internal-2", commandId: "create-2", occurrenceKey: "2026-W45-extra",
        task: { ...task, id: "task-2" }, leadThreadId: "thread-2" });
      goals.create({ id: "business-goal", ownerId: "owner", commandId: "goal", title: "Goal", request: "Work", leadBotId: "bot",
        leadThreadId: "goal-thread", executionLimit: 5, workstreamId: "stream", budgetPeriod: "2026-W45" });
      goals.scopes.createWorkstream({ id: "project", ownerId: "owner", areaId: "area", kind: "project", name: "Project" });
      goals.create({ id: "project-goal", ownerId: "owner", commandId: "project-goal", title: "Project", request: "Work", leadBotId: "bot",
        leadThreadId: "project-thread", executionLimit: 5, workstreamId: "project" });
      const budget = openExecutionBudgetStore(path);
      try {
        budget.bindRoot("internal-1", "root-1");
        budget.bindRoot("internal-2", "root-2");
        budget.bindRoot("business-goal", "goal-root");
        budget.bindRoot("project-goal", "project-root");
        expect(budget.admit("root-1", "root-1", 1)).toBe(true);
        expect(budget.admit("root-1", "child-1", 1)).toBe(true);
        expect(budget.admit("root-2", "root-2", 1)).toBe(false);
        expect(budget.admit("goal-root", "goal-root", 1)).toBe(false);
        expect(budget.admit("project-root", "project-root", 1)).toBe(true);
        expect(budget.admit("project-root", "project-child", 1)).toBe(false);
        expect(budget.usage("internal-1")).toEqual({ limit: 10, reserved: 2 });
      } finally { budget.close(); }
    } finally { goals.close(); }
    const reopened = openGoalStore(path);
    const budget = openExecutionBudgetStore(path);
    try {
      expect(reopened.createStandalone({ ...create, commandId: "replay", containerId: "new-id", task: { ...task, id: "new-task" } }).goalId).toBe("internal-1");
      expect(budget.admit("root-2", "root-2", 1)).toBe(false);
      expect(reopened.scopes.list("owner").workstreams).toEqual(expect.arrayContaining([expect.objectContaining({ id: "stream", status: "active" })]));
    } finally { budget.close(); reopened.close(); await removeTempDir(dir); }
  });

  it("runs a standalone item through the existing dispatch, result and file-check pipeline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-pipeline-"));
    const workspace = join(dir, "files"); mkdirSync(workspace);
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path);
    const budget = openExecutionBudgetStore(path);
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, assignment, no) => budget.admit(root, assignment, no) });
    let allowReview = false;
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "scheduler.db"), authorize: () => true, log: () => {},
      prepareReadyReview: candidate => !allowReview ? undefined : ({ goalId: candidate.goalId, attemptId: "review", authorizationRef: "owner",
        request: { dispatchKey: "review-key", rootId: "review-root", requesterRef: "review", origin: { kind: "person", source: "chat" },
          assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "thread" } }, brief: "Review", level: "ask", delegation: "deny" } }) });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let toolError: unknown;
    try {
      goals.scopes.createArea({ id: "a", ownerId: "owner", name: "Research" });
      goals.scopes.createWorkstream({ id: "w", ownerId: "owner", areaId: "a", name: "Weekly", kind: "ongoing" });
      goals.scopes.setGlobalBudget({ ownerId: "owner", limit: 5 });
      goals.scopes.setPeriodBudget({ ownerId: "owner", workstreamId: "w", periodKey: "week", limit: 3 });
      goals.createStandalone({ containerId: "container", ownerId: "owner", commandId: "create", workstreamId: "w", leadThreadId: "thread",
        budgetPeriod: "week", routineId: "weekly", occurrenceKey: "week", executionLimit: 3,
        task: { id: "task", title: "Weekly brief", brief: "Write the brief", assigneeBotId: "bot", required: true, workspaceRef: "allowed", dependsOn: [],
          criteria: [{ id: "criterion", description: "File", kind: "artifact_exists", required: true, config: { logicalName: "brief" } }] } });
      goals.prepareWork({ ownerId: "owner", goalId: "container", commandId: "work", taskId: "task", expectedVersion: 2,
        intent: { goalId: "container", attemptId: "attempt", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root",
          requesterRef: "attempt", origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Write the brief", level: "ask" } } }, () => workspace);
      runner.script("bot", custom(async ({ a }) => {
        try {
          writeFileSync(join(workspace, "brief.txt"), "Weekly report");
          const context = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
          const tools = createWorkTools({ goals, context, resolveAuthorizedRoots: () => [workspace], isCurrentRun: ctx => {
            const current = runtimeStore.get(ctx.rootId);
            return current?.status === "running" && current.executions === ctx.executionNo && current.assignee.botId === ctx.botId && current.assignee.destination.threadId === ctx.threadId;
          } });
          const snapshot = tools.getGoalContext();
          expect(snapshot).toMatchObject({ areaId: "a", workstreamId: "w", taskId: "task" });
          expect(snapshot).not.toHaveProperty("goalId");
          const artifact = await tools.registerArtifact({ commandId: "artifact", expectedVersion: snapshot.version, logicalName: "brief", reference: "brief.txt" });
          expect(artifact).not.toHaveProperty("goalId");
          tools.submitTaskResult({ commandId: "result", expectedVersion: artifact.version, requirementRevision: 1, planRevision: 1,
            artifactIds: [artifact.artifactId], claims: [{ criterionId: "criterion", verdict: "met", note: "Created" }], knownIssues: [] });
        } catch (error) { toolError = error; throw error; } finally { finish(); }
        return { kind: "completed", text: "done" };
      }));
      scheduler.start(); scheduler.tick();
      await finished;
      await new Promise<void>(resolve => setImmediate(resolve));
      if (toolError) throw toolError;
      scheduler.tick();
      const view = goals.read("container", "owner")!;
      expect(view.tasks[0]).toMatchObject({ status: "checking" });
      await goals.checkRegisteredArtifact({ ownerId: "owner", goalId: "container", taskId: "task", criterionId: "criterion", artifactId: view.artifacts[0]!.id,
        commandId: "check", checkId: "check", expectedVersion: view.version }, () => [workspace]);
      expect(goals.read("container", "owner")?.checks[0]).toMatchObject({ verdict: "pass" });
      let reviewFinished!: () => void;
      const reviewDone = new Promise<void>(resolve => { reviewFinished = resolve; });
      runner.script("bot", custom(async ({ a }) => {
        try {
          const context = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
          const tools = createReviewTools({ goals, context, isCurrentRun: ctx => {
            const current = runtimeStore.get(ctx.rootId);
            return current?.status === "running" && current.executions === ctx.executionNo && current.assignee.botId === ctx.botId && current.assignee.destination.threadId === ctx.threadId;
          }, resolveAuthorizedRoots: () => [workspace] });
          const snapshot = tools.getReviewContext();
          expect(snapshot).not.toHaveProperty("goalId");
          expect(snapshot.evidence.checks).toHaveLength(1);
          const chunk = await tools.readArtifact({ artifactId: view.artifacts[0]!.id, offset: 0, length: 100 });
          expect(Buffer.from(chunk.data, "base64").toString()).toBe("Weekly report");
          await expect(tools.readArtifact({ artifactId: "other", offset: 0, length: 100 })).rejects.toThrow();
          writeFileSync(join(workspace, "brief.txt"), "Tampered");
          await expect(tools.readArtifact({ artifactId: view.artifacts[0]!.id, offset: 0, length: 100 })).rejects.toThrow();
          writeFileSync(join(workspace, "brief.txt"), "Weekly report");
          expect(() => tools.submitReview({ commandId: "empty", expectedVersion: snapshot.version, verdicts: [] })).toThrow();
          tools.submitReview({ commandId: "review-result", expectedVersion: snapshot.version,
            verdicts: [{ criterionId: "criterion", verdict: "pass", reason: "The brief exists and meets its requirement." }] });
        } catch (error) { toolError = error; throw error; } finally { reviewFinished(); }
        return { kind: "completed", text: "reviewed" };
      }));
      allowReview = true;
      scheduler.tick();
      await reviewDone;
      await new Promise<void>(resolve => setImmediate(resolve));
      if (toolError) throw toolError;
      scheduler.tick();
      const finalize = { ownerId: "owner", goalId: "container", taskId: "task", commandId: "finalize", reviewAttemptId: "review",
        expectedVersion: goals.read("container", "owner")!.version };
      goals.scopes.update({ ownerId: "owner", id: "a", type: "area", expectedVersion: 1, status: "paused" });
      await expect(goals.finalizeReview(finalize, () => [workspace])).rejects.toThrow(/not ready/);
      goals.scopes.update({ ownerId: "owner", id: "a", type: "area", expectedVersion: 2, status: "active" });
      writeFileSync(join(workspace, "brief.txt"), "Changed after review");
      await expect(goals.finalizeReview(finalize, () => [workspace])).rejects.toThrow(/changed or unavailable/);
      expect(goals.readStandalone("container", "owner")).toMatchObject({ task: { status: "checking" }, artifacts: [] });
      writeFileSync(join(workspace, "brief.txt"), "Weekly report");
      const finalized = await goals.finalizeReview(finalize, () => [workspace]);
      expect(await goals.finalizeReview(finalize, () => [workspace])).toEqual(finalized);
      expect(goals.readStandalone("container", "owner")).toMatchObject({ task: { status: "succeeded" },
        artifacts: [{ id: view.artifacts[0]!.id, logicalName: "brief" }] });
      writeFileSync(join(workspace, "brief.txt"), "Changed later");
      expect(goals.readArtifactSnapshot({ ownerId: "owner", goalId: "container", artifactId: view.artifacts[0]!.id })?.toString()).toBe("Weekly report");
      expect(goals.readArtifactSnapshot({ ownerId: "other", goalId: "container", artifactId: view.artifacts[0]!.id })).toBeUndefined();
      expect(goals.scopes.list("owner").workstreams).toEqual(expect.arrayContaining([expect.objectContaining({ id: "w", status: "active" })]));
      expect(budget.usage("container")).toEqual({ limit: 3, reserved: 2 });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });
});
