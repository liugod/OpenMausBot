import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, custom } from "../runtime/testing/fake-runner.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { openGoalStore, type GoalRunContext } from "./goal-store.ts";
import { createGoalScheduler } from "./scheduler.ts";
import { createWorkTools } from "./work-tools.ts";

describe("bound goal work tools", () => {
  it("requires a live task result and a real authorized file before checking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-work-tools-"));
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "result.txt"), "actual file");
    writeFileSync(join(workspace, "result.json"), '{"count":2}');
    writeFileSync(join(dir, "outside.txt"), "private");
    const goals = openGoalStore(join(dir, "goals.db"), { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(join(dir, "goals.db"));
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    let finished!: () => void;
    const workFinished = new Promise<void>(resolve => { finished = resolve; });
    let notifyStarted!: () => void;
    const workStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
    let continueWork!: () => void;
    const allowWork = new Promise<void>(resolve => { continueWork = resolve; });
    let toolError: unknown;
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "thread", executionLimit: 4 });
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "initial", tasks: [{ id: "task", title: "Task", brief: "Work", assigneeBotId: "worker", required: true,
          workspaceRef: "allowed", dependsOn: [], criteria: [{ id: "criterion", description: "Result file", kind: "artifact_exists", required: true,
            config: { logicalName: "result" } }, { id: "json-criterion", description: "Structured result", kind: "json_schema", required: true,
            config: { logicalName: "structured", schema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"] } } }] }] });
      goals.prepareWork({ goalId: "g", ownerId: "owner", commandId: "work", taskId: "task", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "attempt", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "attempt",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "worker", destination: { kind: "work_thread", threadId: "worker-thread" } },
          brief: "Work", level: "ask" } } }, ref => ref);
      runner.script("worker", custom(async ({ a }) => {
        try {
          notifyStarted();
          await allowWork;
          const context: GoalRunContext = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
          const live = (candidate: GoalRunContext) => {
            const current = runtimeStore.get(candidate.rootId);
            return current?.status === "running" && current.executions === candidate.executionNo && current.assignee.botId === candidate.botId &&
              current.assignee.destination.threadId === candidate.threadId;
          };
          const roots = (ref: string) => ref === "allowed" ? [workspace] : [];
          const tools = createWorkTools({ goals, context, isCurrentRun: live, resolveAuthorizedRoots: roots });
          expect(tools.getGoalContext()).toMatchObject({ goalId: "g", taskId: "task", planRevision: 1 });
          expect(() => createWorkTools({ goals, context: { ...context, botId: "other" }, isCurrentRun: live, resolveAuthorizedRoots: roots }).getGoalContext())
            .toThrow(/not authorized|does not match/);
          const args = { commandId: "artifact", expectedVersion: goals.read("g", "owner")!.version, logicalName: "result", reference: "result.txt" };
          await expect(tools.registerArtifact({ ...args, goalId: "other" })).rejects.toThrow();
          await expect(tools.registerArtifact({ ...args, commandId: "outside", reference: "../outside.txt" })).rejects.toMatchObject({ status: 403 });
          const artifact = await tools.registerArtifact(args);
          expect(await tools.registerArtifact(args)).toEqual(artifact);
          expect(await tools.registerArtifact({ ...args, commandId: "same-file", expectedVersion: artifact.version }))
            .toEqual(artifact);
          const jsonArtifact = await tools.registerArtifact({ ...args, commandId: "json-artifact", expectedVersion: artifact.version,
            logicalName: "structured", reference: "result.json" });
          const snapshot = tools.getGoalContext();
          const result = { commandId: "result", expectedVersion: snapshot.version, requirementRevision: 1, planRevision: 1,
            artifactIds: [artifact.artifactId, jsonArtifact.artifactId], claims: [{ criterionId: "criterion", verdict: "met", note: "File created" },
              { criterionId: "json-criterion", verdict: "met", note: "Structured output created" }], knownIssues: [] };
          expect(() => tools.submitTaskResult({ ...result, artifactIds: ["missing"] })).toThrow(/unavailable artifact/);
          expect(() => tools.submitTaskResult({ ...result, claims: [] })).toThrow(/every criterion/);
          tools.submitTaskResult(result);
        } catch (error) { toolError = error; throw error; } finally { finished(); }
        return { kind: "completed", text: "done" };
      }));
      scheduler.start(); scheduler.tick();
      await workStarted;
      goals.setPaused({ goalId: "g", ownerId: "owner", commandId: "pause", expectedVersion: goals.read("g", "owner")!.version, paused: true });
      continueWork();
      await workFinished;
      await new Promise<void>(resolve => setImmediate(resolve));
      if (toolError) throw toolError;
      scheduler.tick();
      const view = goals.read("g", "owner")!;
      expect(view.status).toBe("paused");
      expect(view.tasks[0]).toMatchObject({ status: "checking" });
      expect(view.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ logicalName: "result", bytes: 11, revision: 1 }),
        expect.objectContaining({ logicalName: "structured", revision: 1 })]));
      const artifact = view.artifacts.find(item => item.logicalName === "result")!;
      const jsonArtifact = view.artifacts.find(item => item.logicalName === "structured")!;
      const check = { ownerId: "owner", commandId: "check", goalId: "g", taskId: "task", criterionId: "criterion", artifactId: artifact.id,
        checkId: "check-a", expectedVersion: view.version };
      await expect(goals.checkRegisteredArtifact(check, () => [workspace])).rejects.toThrow(/version conflict/);
      goals.setPaused({ goalId: "g", ownerId: "owner", commandId: "resume", expectedVersion: goals.read("g", "owner")!.version, paused: false });
      await goals.checkRegisteredArtifact({ ...check, commandId: "json-check", checkId: "json-check", criterionId: "json-criterion",
        artifactId: jsonArtifact.id, expectedVersion: goals.read("g", "owner")!.version }, () => [workspace]);
      await goals.checkRegisteredArtifact({ ...check, expectedVersion: goals.read("g", "owner")!.version }, () => [workspace]);
      writeFileSync(join(workspace, "result.txt"), "changed");
      await goals.checkRegisteredArtifact({ ...check, commandId: "check-again", checkId: "check-b", expectedVersion: goals.read("g", "owner")!.version }, () => [workspace]);
      expect(goals.read("g", "owner")?.checks.map(item => item.verdict)).toEqual(["pass", "pass", "fail"]);
      expect(goals.read("g", "owner")?.tasks[0]).toMatchObject({ status: "checking" });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });
});
