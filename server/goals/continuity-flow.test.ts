import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, custom } from "../runtime/testing/fake-runner.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore, type DispatchIntent } from "./execution-budget.ts";
import { openGoalStore, type GoalRunContext } from "./goal-store.ts";
import { createGoalScheduler } from "./scheduler.ts";
import { createGoalToolDispatcher } from "./tool-dispatch.ts";

it("resumes after reopening storage, delivers a real file, then rechecks an amendment with cumulative budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-continuity-flow-")), path = join(dir, "goals.db");
  let goals = openGoalStore(path);
  const budget = openExecutionBudgetStore(path), runtimeStore = openRuntimeStore(join(dir, "runtime.db")), runner = new FakeRunner();
  const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
  const live = (ctx: GoalRunContext) => {
    const current = runtimeStore.get(ctx.rootId);
    return current?.status === "running" && current.executions === ctx.executionNo && current.assignee.botId === ctx.botId && current.assignee.destination.threadId === ctx.threadId;
  };
  const dispatcher = () => createGoalToolDispatcher({ goals, isCurrentRun: live, canAssignBot: () => false, canUseWorkspace: () => false, resolveAuthorizedRoots: () => [dir] });
  let dispatch = dispatcher();
  const intent = (attemptId: string): DispatchIntent => ({ goalId: "item", attemptId, authorizationRef: "owner", request: {
    dispatchKey: attemptId, rootId: attemptId, requesterRef: attemptId, origin: { kind: "person", source: "chat" },
    assignee: { botId: "bot", destination: { kind: "work_thread", threadId: attemptId } }, brief: "Inspect current task context", level: "ask", delegation: "deny" } });
  const schedulerFor = () => createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "scheduler.db"), authorize: () => true, log: () => {},
    prepareReadyWork: candidate => ({ intent: intent(`work-${candidate.taskRevision}`), resolveWritableWorkspace: () => dir }),
    prepareReadyReview: candidate => {
      const reviewIntent = intent(`review-${goals.readTaskContinuation(candidate.goalId, candidate.taskId, candidate.ownerId)!.taskRevision}`);
      reviewIntent.request.assignee.destination.threadId = "lead";
      return reviewIntent;
    } });
  let scheduler = schedulerFor();
  let error: unknown;
  const waitFor = async (predicate: () => boolean) => {
    for (let count = 0; count < 100; count++) {
      if (error) throw error;
      scheduler.tick();
      if (predicate()) return;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    throw new Error("fixture workflow did not settle");
  };
  const successfulWork = (revision: number, text: string) => custom(async ({ a }) => {
    try {
      const ctx = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
      const state = await dispatch(ctx, "goal_context", {}) as ReturnType<typeof goals.workContext>;
      expect(state.continuation.taskRevision).toBe(revision);
      if (revision === 2) expect(readFileSync(join(dir, "result.txt"), "utf8")).toBe("draft");
      if (revision === 3) expect(state.task.criteria.some(criterion => criterion.description.includes("source links"))).toBe(true);
      writeFileSync(join(dir, "result.txt"), text);
      const artifact = await dispatch(ctx, "register_goal_artifact", { commandId: `artifact-${revision}`, expectedVersion: state.version,
        logicalName: "result", reference: "result.txt" }) as { artifactId: string; version: number };
      await dispatch(ctx, "submit_goal_task_result", { commandId: `result-${revision}`, expectedVersion: artifact.version, requirementRevision: 1, planRevision: 1,
        artifactIds: [artifact.artifactId], claims: state.task.criteria.map(c => ({ criterionId: c.id, verdict: "met", note: "Saved actual output" })), knownIssues: [] });
    } catch (reason) { error = reason; throw reason; }
    return { kind: "completed", text: "output ready" };
  });
  const review = (revision: number, text: string) => custom(async ({ a }) => {
    try {
      const ctx = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
      const state = await dispatch(ctx, "goal_context", {}) as ReturnType<typeof goals.reviewContext>;
      expect(state.originalRequest).toBe("Write report");
      const chunk = await dispatch(ctx, "read_goal_review_artifact", { artifactId: state.evidence.artifacts[0]!.id, offset: 0, length: 100 }) as { data: string };
      expect(Buffer.from(chunk.data, "base64").toString()).toBe(text);
      await dispatch(ctx, "submit_goal_review", { commandId: `verdict-${revision}`, expectedVersion: state.version,
        verdicts: state.evidence.criteria.filter(c => c.required).map(c => ({ criterionId: c.id, verdict: "pass", reason: "Inspected current bytes and request" })) });
    } catch (reason) { error = reason; throw reason; }
    return { kind: "completed", text: "reviewed" };
  });
  try {
    goals.scopes.createArea({ id: "area", ownerId: "owner", name: "Research" });
    goals.scopes.createWorkstream({ id: "stream", ownerId: "owner", areaId: "area", name: "Reports", kind: "project" });
    goals.scopes.setGlobalBudget({ ownerId: "owner", limit: 8 });
    goals.createStandalone({ containerId: "item", ownerId: "owner", commandId: "create", workstreamId: "stream", leadThreadId: "lead", executionLimit: 8,
      task: { id: "task", title: "Report", brief: "Write report", assigneeBotId: "bot", required: true, workspaceRef: "allowed", dependsOn: [],
        criteria: [{ id: "file", description: "Actual report", kind: "artifact_exists", required: true, config: { logicalName: "result" } }] } });
    runner.script("bot", custom(async ({ a }) => {
      try {
        expect(runtime.clientRootStopped(a.rootId)).toBe(false);
        const ctx = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
        const state = await dispatch(ctx, "goal_context", {}) as { version: number };
        writeFileSync(join(dir, "result.txt"), "draft");
        await dispatch(ctx, "save_goal_checkpoint", { commandId: "checkpoint", expectedVersion: state.version, summary: "draft saved", remaining: ["verify"], blockers: [], nextStep: "Inspect draft" });
      } catch (reason) { error = reason; throw reason; }
      return { kind: "failed", outcome: "interrupted", text: "simulated interruption" };
    }));
    scheduler.start();
    await waitFor(() => goals.readStandalone("item", "owner")?.task.status === "blocked");
    expect(runtime.clientRootStopped("work-1")).toBe(true);
    scheduler.close(); goals.close();
    goals = openGoalStore(path); dispatch = dispatcher(); scheduler = schedulerFor();
    expect(goals.readTaskContinuation("item", "task", "owner")!.checkpoint?.summary).toBe("draft saved");
    goals.changeTask({ commandId: "resume", expectedVersion: goals.read("item", "owner")!.version, instruction: "Check existing draft", externalStateChecked: true },
      { goalId: "item", taskId: "task", ownerId: "owner" }, "resume", root => runtime.clientRootStopped(root));
    runner.script("bot", successfulWork(2, "verified report"), review(2, "verified report"));
    scheduler.start();
    for (const revision of [2, 3]) {
      await waitFor(() => goals.readStandalone("item", "owner")?.task.status === "checking");
      const view = goals.read("item", "owner")!, artifact = view.artifacts.at(-1)!;
      await goals.checkRegisteredArtifact({ ownerId: "owner", goalId: "item", taskId: "task", criterionId: "file", artifactId: artifact.id,
        checkId: `check-${revision}`, commandId: `check-${revision}`, expectedVersion: view.version }, () => [dir]);
      await waitFor(() => goals.read("item", "owner")!.reviewAttempts.at(-1)?.status === "succeeded");
      await goals.finalizeReview({ ownerId: "owner", goalId: "item", taskId: "task", reviewAttemptId: `review-${revision}`, commandId: `final-${revision}`,
        expectedVersion: goals.read("item", "owner")!.version }, () => [dir]);
      expect(goals.readStandalone("item", "owner")!.task.status).toBe("succeeded");
      if (revision === 2) {
        goals.changeTask({ commandId: "amend", expectedVersion: goals.read("item", "owner")!.version, instruction: "Add source links", externalStateChecked: true },
          { goalId: "item", taskId: "task", ownerId: "owner" }, "amend", root => runtime.clientRootStopped(root));
        expect(goals.readArtifactSnapshot({ goalId: "item", ownerId: "owner", artifactId: artifact.id })).toBeUndefined();
        runner.script("bot", successfulWork(3, "verified report with source links"), review(3, "verified report with source links"));
      }
    }
    expect(budget.usage("item")).toEqual({ limit: 8, reserved: 5 });
    expect(goals.scopes.budgets("owner").global).toEqual({ limit: 8, used: 5 });
  } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
});
