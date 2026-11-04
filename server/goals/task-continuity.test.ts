import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";

function setup(path: string) {
  const goals = openGoalStore(path, { unsafeTestPlanBootstrap: true });
  goals.create({ id: "g", ownerId: "owner", commandId: "create", title: "Research", request: "Write a report and summary", leadBotId: "lead", leadThreadId: "lead", executionLimit: 8 });
  goals.submitInitialPlanUnchecked({ goalId: "g", ownerId: "owner", commandId: "plan", expectedVersion: 1, requirementRevision: 1,
    sourceAttemptId: "plan", reason: "initial", tasks: ["report", "summary", "unrelated"].map(id => ({ id, title: id, brief: `Write ${id}`, assigneeBotId: "bot", required: true,
      workspaceRef: id, dependsOn: id === "summary" ? ["report"] : [], criteria: [{ id: "review", description: "Useful content", kind: "lead_review" as const, required: true, config: {} }] })) });
  return goals;
}

function accepted(raw: DatabaseSync, taskId: string) {
  const contents = Buffer.from(taskId), sha = createHash("sha256").update(contents).digest("hex");
  raw.prepare("UPDATE goal_tasks SET status='succeeded' WHERE id=?").run(taskId);
  raw.prepare("INSERT INTO goal_attempts (id,goal_id,task_id,root_id,workspace_ref,status,created_at) VALUES (?,'g',?,?,?,'succeeded',1)")
    .run(`work-${taskId}`, taskId, `root-${taskId}`, taskId);
  raw.prepare("INSERT INTO goal_review_attempts (id,goal_id,task_id,root_id,bot_id,thread_id,evidence_json,status,created_at) VALUES (?,'g',?,?,'lead','lead',?,'applied',1)")
    .run(`review-${taskId}`, taskId, `review-root-${taskId}`, JSON.stringify({ artifacts: [{ id: `artifact-${taskId}` }] }));
  raw.prepare("INSERT INTO goal_artifacts VALUES (?,'g',?,?,'result',1,'result.txt',?,?,'text/plain',1,1)")
    .run(`artifact-${taskId}`, taskId, `work-${taskId}`, sha, contents.length);
  raw.prepare("INSERT INTO goal_artifact_snapshots VALUES (?,?,?,?,1)").run(`artifact-${taskId}`, sha, contents.length, contents);
}

describe("task continuation", () => {
  it("keeps checkpoint notes unverified across restart, preserves identity and budgets, and rejects stale or forged writers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-continuity-")), path = join(dir, "goals.db");
    let goals = setup(path);
    const budget = openExecutionBudgetStore(path);
    try {
      goals.prepareWork({ goalId: "g", ownerId: "owner", taskId: "report", commandId: "work", expectedVersion: 2,
        intent: { goalId: "g", attemptId: "attempt", authorizationRef: "owner", request: { rootId: "root", dispatchKey: "key", requesterRef: "attempt",
          assignee: { botId: "bot", destination: { kind: "work_thread", threadId: "work-thread" } }, origin: { kind: "person", source: "chat" }, brief: "Write", level: "ask" } } }, ref => ref);
      const raw = new DatabaseSync(path);
      raw.exec("UPDATE goal_attempts SET status='running'; UPDATE goal_tasks SET status='running' WHERE id='report';"); raw.close();
      const context = { rootId: "root", botId: "bot", threadId: "work-thread", executionNo: 1 };
      const note = { commandId: "checkpoint", expectedVersion: goals.read("g", "owner")!.version,
        summary: "Draft written; not verified", remaining: ["Check sources"], blockers: [], nextStep: "Inspect the draft and verify sources" };
      expect(() => goals.saveTaskCheckpoint(note, { ...context, botId: "other" }, () => true)).toThrow();
      expect(() => goals.saveTaskCheckpoint(note, context, () => false)).toThrow();
      const saved = goals.saveTaskCheckpoint(note, context, () => true);
      expect(goals.saveTaskCheckpoint(note, context, () => true)).toEqual(saved);
      expect(() => goals.saveTaskCheckpoint({ ...note, commandId: "stale" }, context, () => true)).toThrow(/version/);
      budget.reserve("g", "run-one", 1);
      goals.close(); goals = openGoalStore(path);
      expect(goals.readTaskContinuation("g", "report", "other")).toBeUndefined();
      expect(goals.readTaskContinuation("g", "report", "owner")).toMatchObject({ taskRevision: 1, checkpoint: { trust: "unverified_executor_note", summary: note.summary } });
      expect(goals.read("g", "owner")!.tasks[0]!.status).toBe("running");
      const blocked = new DatabaseSync(path);
      blocked.exec("UPDATE goal_attempts SET status='failed'; UPDATE goal_tasks SET status='blocked' WHERE id='report'; UPDATE goals SET status='blocked' WHERE id='g';"); blocked.close();
      const args = { commandId: "resume", expectedVersion: saved.version, instruction: "Verify existing draft first", externalStateChecked: true };
      expect(() => goals.changeTask(args, { goalId: "g", taskId: "report", ownerId: "owner" }, "resume", () => false)).toThrow(/stop/);
      const result = goals.changeTask(args, { goalId: "g", taskId: "report", ownerId: "owner" }, "resume", () => true);
      expect(goals.changeTask(args, { goalId: "g", taskId: "report", ownerId: "owner" }, "resume", () => true)).toEqual(result);
      expect(goals.read("g", "owner")!.tasks[0]).toMatchObject({ id: "report", status: "planned", continuation: { taskRevision: 2 } });
      expect(goals.readyWork("", "", 100).find(task => task.task.id === "report")?.taskRevision).toBe(2);
      expect(budget.usage("g")).toEqual({ limit: 8, reserved: 1 });
    } finally { budget.close(); goals.close(); await removeTempDir(dir); }
  });

  it("invalidates only the amended task and dependents, retains historical evidence and unrelated delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-amend-")), path = join(dir, "goals.db");
    const goals = setup(path);
    try {
      const raw = new DatabaseSync(path);
      for (const id of ["report", "summary", "unrelated"]) accepted(raw, id);
      const input = { commandId: "amend", expectedVersion: 2, instruction: "Include primary source links", externalStateChecked: true };
      const identity = { goalId: "g", taskId: "report", ownerId: "owner" };
      expect(() => goals.changeTask(input, { ...identity, ownerId: "other" }, "amend", () => true)).toThrow();
      raw.prepare("UPDATE goal_attempts SET status='running' WHERE task_id='summary'").run();
      expect(() => goals.changeTask(input, identity, "amend", () => true)).toThrow(/stop/);
      expect(goals.read("g", "owner")!.tasks[0]!.criteria).toHaveLength(1);
      raw.prepare("UPDATE goal_attempts SET status='succeeded' WHERE task_id='summary'").run();
      raw.close();
      expect(goals.changeTask(input, identity, "amend", () => true).affectedTaskIds).toEqual(["report", "summary"]);
      const changed = goals.read("g", "owner")!;
      expect(changed.tasks.map(task => task.status)).toEqual(["planned", "planned", "succeeded"]);
      expect(changed.tasks[0]!.criteria).toContainEqual(expect.objectContaining({ kind: "lead_review", description: "Verify user amendment: Include primary source links" }));
      expect(changed.tasks[0]!.brief).toContain("Write report");
      expect(changed.request).toBe("Write a report and summary");
      expect(changed.artifacts).toHaveLength(3);
      expect(goals.readArtifactSnapshot({ goalId: "g", ownerId: "owner", artifactId: "artifact-report" })).toBeUndefined();
      expect(goals.readArtifactSnapshot({ goalId: "g", ownerId: "owner", artifactId: "artifact-unrelated" })?.toString()).toBe("unrelated");
      expect(changed.reviewAttempts.filter(review => review.status === "applied").map(review => review.taskId)).toEqual(["unrelated"]);
      const candidates = goals.readyWork("", "", 100).map(item => item.task.id);
      expect(candidates).toEqual(["report"]);
      expect(() => goals.changeTask({ ...input, commandId: "old" }, identity, "amend", () => true)).toThrow(/version/);
      expect(() => goals.changeTask({ ...input, commandId: "unsafe", expectedVersion: changed.version, externalStateChecked: false }, identity, "resume", () => true)).toThrow();
    } finally { goals.close(); await removeTempDir(dir); }
  });
});
