import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";
import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore } from "../runtime/store.ts";
import { FakeRunner, custom } from "../runtime/testing/fake-runner.ts";
import type { RunResult } from "../runtime/types.ts";
import { createGoalScheduler } from "./scheduler.ts";
import { createWorkTools } from "./work-tools.ts";

describe("review gates", () => {
  it("passes the exact reviewed snapshot downstream and blocks a result if its input becomes stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-input-snapshot-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(path);
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let release!: () => void;
    const continueRun = new Promise<void>(resolve => { release = resolve; });
    let workerError: unknown;
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead", executionLimit: 5 });
      const task = { id: "first", title: "First", brief: "Work", assigneeBotId: "bot", required: true, workspaceRef: "workspace", dependsOn: [] as string[],
        criteria: [{ id: "criterion", description: "Review", kind: "lead_review" as const, required: true, config: {} }] };
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "test", tasks: [task, { ...task, id: "second", dependsOn: ["first"] }] });
      const content = Buffer.from("reviewed input");
      const sha = createHash("sha256").update(content).digest("hex");
      const evidence = { attemptId: "work", requirementRevision: 1, planRevision: 1, artifacts: [{ id: "artifact", logicalName: "source", sha256: sha, bytes: content.length }] };
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`UPDATE goal_tasks SET status='succeeded' WHERE id='first';
          INSERT INTO goal_attempts (id, goal_id, task_id, root_id, workspace_ref, status, created_at) VALUES ('work','g','first','old-root','workspace','succeeded',1);
          INSERT INTO goal_review_attempts (id, goal_id, task_id, root_id, bot_id, thread_id, evidence_json, status, created_at)
            VALUES ('review','g','first','review-root','lead','lead','{}','applied',1);`);
        raw.prepare("UPDATE goal_review_attempts SET evidence_json=? WHERE id='review'").run(JSON.stringify(evidence));
        raw.prepare(`INSERT INTO goal_artifacts (id, goal_id, task_id, attempt_id, logical_name, revision, reference, sha256, bytes, media_type, requirement_revision, created_at)
          VALUES ('artifact','g','first','work','source',1,'input.txt',?,?,'text/plain',1,1)`).run(sha, content.length);
        raw.prepare("INSERT INTO goal_artifact_snapshots VALUES ('artifact', ?, ?, ?, 1)").run(sha, content.length, content);
      } finally { raw.close(); }
      goals.prepareWork({ goalId: "g", ownerId: "owner", commandId: "work", taskId: "second", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "next", authorizationRef: "owner", request: { dispatchKey: "next-key", rootId: "next-root", requesterRef: "next",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "thread" } }, brief: "Work", level: "ask" } } }, ref => ref);
      runner.script("bot", custom(async ({ a }) => {
        try {
          const context = { rootId: a.rootId, botId: a.assignee.botId, threadId: a.assignee.destination.threadId, executionNo: a.executions };
          const tools = createWorkTools({ goals, context, resolveAuthorizedRoots: () => [], isCurrentRun: ctx => runtimeStore.get(ctx.rootId)?.status === "running" });
          expect(tools.listInputs()).toEqual([expect.objectContaining({ predecessorTaskId: "first", artifactId: "artifact", sha256: sha })]);
          const chunk = tools.readInput({ artifactId: "artifact", offset: 0, length: 100 });
          expect(Buffer.from(chunk.dataBase64, "base64")).toEqual(content);
          expect(() => tools.readInput({ artifactId: "other", offset: 0, length: 100 })).toThrow(/not authorized/);
          ready(); await continueRun;
          expect(() => tools.getGoalContext()).toThrow(/not authorized or current/);
        } catch (error) { workerError = error; ready(); throw error; }
        return { kind: "completed", text: "late output" };
      }));
      scheduler.start(); scheduler.tick();
      await started;
      if (workerError) throw workerError;
      const invalidate = new DatabaseSync(path);
      try {
        invalidate.prepare(`INSERT INTO goal_artifacts (id, goal_id, task_id, attempt_id, logical_name, revision, reference, sha256, bytes, media_type, requirement_revision, created_at)
          VALUES ('new-artifact','g','first','work','source',2,'input.txt',?,?,'text/plain',1,2)`).run(sha, content.length);
      } finally { invalidate.close(); }
      expect(budget.admit("next-root", "late-child", 1)).toBe(false);
      scheduler.tick();
      expect(goals.read("g", "owner")?.tasks[1]).toMatchObject({ status: "blocked", blocker: "stale_inputs" });
      release();
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      if (workerError) throw workerError;
      expect(goals.read("g", "owner")?.tasks[1]).toMatchObject({ status: "blocked", blocker: "stale_inputs" });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("keeps cancellation pending until an uncooperative review settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-review-stop-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(path);
    const runtimeStore = openRuntimeStore(join(dir, "runtime.db"));
    const runner = new FakeRunner();
    let finish: ((result: RunResult) => void) | undefined;
    runner.script("lead", custom(() => new Promise<RunResult>(resolve => { finish = resolve; })));
    const runtime = new Runtime(runtimeStore, runner, { admitClientExecution: (root, id, no) => budget.admit(root, id, no) });
    const scheduler = createGoalScheduler({ goals, budget, runtime, runtimeStore, lockPath: join(dir, "owner.db"), authorize: () => true, log: () => {} });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 5 });
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "test", tasks: [{ id: "task", title: "Task", brief: "Work", assigneeBotId: "worker", required: true,
          workspaceRef: "workspace", dependsOn: [], criteria: [{ id: "quality", description: "Quality", kind: "lead_review", required: true, config: {} }] }] });
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`INSERT INTO goal_attempts (id, goal_id, task_id, root_id, workspace_ref, status, created_at) VALUES ('work','g','task','work-root','workspace','succeeded',1);
          UPDATE goal_tasks SET status='checking' WHERE id='task';
          INSERT INTO goal_execution_roots (root_id, goal_id) VALUES ('work-root','g');
          INSERT INTO goal_dispatch_outbox (dispatch_key, attempt_id, root_id, goal_id, request_json, state) VALUES ('work-key','work','work-root','g','{}','accepted');
          INSERT INTO goal_task_results (attempt_id, goal_id, task_id, requirement_revision, plan_revision, result_json, created_at) VALUES ('work','g','task',1,1,'{"artifactIds":[]}',1);`);
      } finally { raw.close(); }
      goals.prepareReview({ goalId: "g", ownerId: "owner", commandId: "review", taskId: "task", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "review-attempt", authorizationRef: "owner", request: { dispatchKey: "review-key", rootId: "review-root",
          requesterRef: "review-attempt", origin: { kind: "person", source: "chat" }, assignee: { botId: "lead", destination: { kind: "work_thread", threadId: "lead-thread" } },
          brief: "Review", level: "ask", delegation: "deny" } } });
      scheduler.start(); scheduler.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtimeStore.get("review-root")?.status).toBe("running");
      goals.cancel({ goalId: "g", ownerId: "owner", commandId: "cancel", expectedVersion: goals.read("g", "owner")!.version });
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "cancelled", stopPending: true });
      expect(finish).toBeDefined();
      finish!({ kind: "completed", text: "late review" });
      await new Promise<void>(resolve => setImmediate(resolve));
      scheduler.tick();
      expect(goals.read("g", "owner")).toMatchObject({ status: "cancelled", stopPending: false, tasks: [{ status: "cancelled" }] });
    } finally { scheduler.close(); runtimeStore.close(); budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("does not dispatch dependent work without a current accepted review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-input-gate-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead", executionLimit: 5 });
      const task = { id: "first", title: "First", brief: "Work", assigneeBotId: "bot", required: true, workspaceRef: "workspace", dependsOn: [] as string[],
        criteria: [{ id: "criterion", description: "Review", kind: "lead_review" as const, required: true, config: {} }] };
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "test", tasks: [task, { ...task, id: "second", dependsOn: ["first"] }] });
      const raw = new DatabaseSync(path);
      try { raw.prepare("UPDATE goal_tasks SET status='succeeded' WHERE id='first'").run(); } finally { raw.close(); }
      expect(() => goals.prepareWork({ goalId: "g", ownerId: "owner", commandId: "work", taskId: "second", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "attempt", authorizationRef: "owner", request: { dispatchKey: "key", rootId: "root", requesterRef: "attempt",
          origin: { kind: "person", source: "chat" }, assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "thread" } },
          brief: "Work", level: "ask" } } }, ref => ref)).toThrow(/current accepted review/);
      expect(goals.read("g", "owner")?.tasks[1]).toMatchObject({ status: "planned" });
    } finally { goals.close(); await removeTempDir(dir); }
  });

  it.each(["fail", "unknown"] as const)("does not complete a task when review is %s", async verdict => {
    const dir = mkdtempSync(join(tmpdir(), "goal-review-gate-"));
    const path = join(dir, "goals.db");
    const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
    const budget = openExecutionBudgetStore(path);
    try {
      goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Goal", request: "Work", leadBotId: "lead", leadThreadId: "lead-thread", executionLimit: 5 });
      goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
        sourceAttemptId: "plan", reason: "test", tasks: [{ id: "task", title: "Task", brief: "Work", assigneeBotId: "worker", required: true,
          workspaceRef: "workspace", dependsOn: [], criteria: [{ id: "quality", description: "Quality", kind: "lead_review", required: true, config: {} }] }] });
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`INSERT INTO goal_attempts (id, goal_id, task_id, root_id, workspace_ref, status, created_at) VALUES ('work','g','task','work-root','workspace','succeeded',1);
          UPDATE goal_tasks SET status='checking' WHERE id='task';
          INSERT INTO goal_execution_roots (root_id, goal_id) VALUES ('work-root','g');
          INSERT INTO goal_dispatch_outbox (dispatch_key, attempt_id, root_id, goal_id, request_json, state)
            VALUES ('work-key','work','work-root','g','{}','accepted');
          INSERT INTO goal_task_results (attempt_id, goal_id, task_id, requirement_revision, plan_revision, result_json, created_at)
            VALUES ('work','g','task',1,1,'{"artifactIds":[]}',1);`);
      } finally { raw.close(); }
      goals.prepareReview({ goalId: "g", ownerId: "owner", commandId: "review", taskId: "task", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "review-attempt", authorizationRef: "owner", request: { dispatchKey: "review-key", rootId: "review-root",
          requesterRef: "review-attempt", origin: { kind: "person", source: "chat" }, assignee: { botId: "lead", destination: { kind: "work_thread", threadId: "lead-thread" } },
          brief: "Review", level: "ask", delegation: "deny" } } });
      budget.acknowledgeDispatch("review-key", "review-root");
      const context = { rootId: "review-root", botId: "lead", threadId: "lead-thread", executionNo: 1 };
      expect(() => goals.reviewContext({ ...context, botId: "other" }, () => true)).toThrow(/not authorized/);
      expect(() => goals.submitReviewFromRun({ commandId: "invalid", expectedVersion: goals.read("g", "owner")!.version,
        verdicts: [{ criterionId: "wrong", verdict: "pass", reason: "Evidence" }] }, context, () => true)).toThrow(/every required criterion/);
      goals.submitReviewFromRun({ commandId: "submit", expectedVersion: goals.read("g", "owner")!.version,
        verdicts: [{ criterionId: "quality", verdict, reason: "Cannot confirm the criterion." }] }, context, () => true);
      const terminal = new DatabaseSync(path);
      try { terminal.prepare("UPDATE goal_review_attempts SET status='succeeded' WHERE id='review-attempt'").run(); } finally { terminal.close(); }
      const input = { goalId: "g", ownerId: "owner", commandId: "finalize", taskId: "task", reviewAttemptId: "review-attempt", expectedVersion: goals.read("g", "owner")!.version };
      const rejected = await goals.finalizeReview(input, () => []);
      expect(await goals.finalizeReview(input, () => [])).toEqual(rejected);
      expect(goals.read("g", "owner")?.tasks[0]).toMatchObject({ status: "blocked", blocker: verdict === "fail" ? "review_changes_requested" : "review_inconclusive" });
      goals.cancel({ goalId: "g", ownerId: "owner", commandId: "cancel", expectedVersion: goals.read("g", "owner")!.version });
      expect(goals.pendingStops(10).map(stop => stop.rootId).sort()).toEqual(["review-root", "work-root"]);
      goals.confirmStop("work-root");
      expect(goals.read("g", "owner")?.stopPending).toBe(true);
      goals.confirmStop("review-root");
      expect(goals.read("g", "owner")).toMatchObject({ status: "cancelled", stopPending: false });
    } finally { budget.close(); goals.close(); await removeTempDir(dir); }
  });
});
