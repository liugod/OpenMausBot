import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { openGoalStore } from "./goal-store.ts";
import { openGsdControl } from "./gsd-control.ts";

it("pins a real assignment, journals commands, detects conflicts and verifies pause and resume evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-gsd-control-")), taskId = "fixture", hash = createHash("sha256").update(taskId).digest("hex");
  const root = join(dir, "gsd-integration"), tree = join(root, "worktrees", hash);
  mkdirSync(join(tree, ".planning"), { recursive: true }); mkdirSync(join(root, "runs"), { recursive: true });
  writeFileSync(join(root, "runs", `${hash}.json`), JSON.stringify({ taskId, state: "ready", worktree: tree }));
  writeFileSync(join(tree, ".planning", "ROADMAP.md"), "initial");
  const goals = openGoalStore(join(dir, "goals.db"));
  goals.createGsdGoal({ taskId, ownerId: "owner", title: "Fixture", request: "Test", leadBotId: "chief", leadThreadId: "chief-thread" });
  const runtime = new DatabaseSync(join(dir, "runtime.db"));
  runtime.exec("CREATE TABLE assignments (id TEXT PRIMARY KEY, assignee_bot_id TEXT, assignee_thread_id TEXT, json TEXT, created_at INTEGER)");
  const put = (id: string, status: string, brief: string, requester = "chief") => {
    const value = { id, status, brief: `${brief} ${tree}`, requester: { botId: requester }, assignee: { botId: "worker", destination: { threadId: "thread" } } };
    runtime.prepare("INSERT OR REPLACE INTO assignments VALUES (?,?,?,?,?)").run(id, "worker", "thread", JSON.stringify(value), Date.now());
  };
  const control = openGsdControl(dir), base = { taskId, ownerId: "owner" };
  try {
    put("wrong", "running", "[[OMB-GSD:fixture]]", "other");
    expect(() => control.registerRun({ ...base, assignmentId: "wrong" })).toThrow(/chief/);
    put("run", "running", "[[OMB-GSD:fixture]] work");
    expect(control.registerRun({ ...base, assignmentId: "run" })).toMatchObject({ botId: "worker", threadId: "thread" });
    const pause = { ...base, commandId: "pause-1", kind: "pause" as const, request: "暂停" };
    expect(control.request(pause).state).toBe("pending"); expect(control.request(pause).state).toBe("pending");
    expect(() => control.request({ ...pause, request: "different" })).toThrow(/conflict/);
    expect(() => control.request({ ...pause, ownerId: "other", commandId: "other" })).toThrow(/not found/);
    expect(control.reserve(pause)).toMatchObject({ state: "dispatching", marker: "[[OMB-GSD-CMD:pause-1]]" });
    expect(() => control.reserve(pause)).toThrow(/reconcile/);
    put("pause-run", "completed", "[[OMB-GSD:fixture]] [[OMB-GSD-CMD:pause-1]] 暂停");
    writeFileSync(join(tree, ".planning", "HANDOFF.json"), '{"version":"1.0","timestamp":"fixture","status":"paused","async_jobs":[]}');
    expect(control.reconcile(pause)).toMatchObject({ state: "sent", result: { reason: "waiting for the original worker to finish" } });
    put("run", "completed", "[[OMB-GSD:fixture]] work");
    expect(control.reconcile(pause)).toMatchObject({ state: "applied", result: { externalJobs: "unverified" } });
    const resume = { ...base, commandId: "resume-1", kind: "resume" as const, request: "继续" };
    control.request(resume);
    writeFileSync(join(tree, ".planning", "HANDOFF.json"), '{"version":"1.0","timestamp":"fixture-2","status":"paused","async_jobs":[{"status":"running"}]}');
    expect(() => control.reserve(resume)).toThrow(/handoff changed/);
    expect(() => control.reviewHandoff({ ...pause, note: "Checked external jobs" })).toThrow(/active or unknown/);
    writeFileSync(join(tree, ".planning", "HANDOFF.json"), '{"version":"1.0","timestamp":"fixture-3","status":"paused","async_jobs":[]}');
    control.reviewHandoff({ ...pause, note: "Checked the external-job inventory" });
    expect(control.reserve(resume).state).toBe("dispatching");
    expect(control.claimDelivery({ ...resume, chiefId: "chief", botId: "worker", threadId: "thread", message: `继续 ${tree}` })).toEqual({ kind: "resume" });
    expect(() => control.claimDelivery({ ...resume, chiefId: "chief", botId: "worker", threadId: "thread", message: `继续 ${tree}` })).toThrow(/already claimed/);
    put("resume-run", "running", "[[OMB-GSD:fixture]] [[OMB-GSD-CMD:resume-1]] 继续");
    control.attach({ ...resume, assignmentId: "resume-run" });
    expect(control.reconcile(resume)).toMatchObject({ state: "applied", assignmentStatus: "running" });
    put("resume-run", "completed", "[[OMB-GSD:fixture]] [[OMB-GSD-CMD:resume-1]] 继续");
    const change = { ...base, commandId: "change-1", kind: "change" as const, request: "新增权限管理" };
    control.request(change); writeFileSync(join(tree, ".planning", "ROADMAP.md"), "concurrent edit");
    expect(control.reserve(change)).toMatchObject({ state: "conflict" });
    expect(control.cancelPending(change)).toMatchObject({ state: "cancelled" });
    const late = { ...base, commandId: "change-2", kind: "change" as const, request: "改变计划" };
    control.request(late); control.reserve(late); writeFileSync(join(tree, ".planning", "STATE.md"), "concurrent state");
    expect(control.claimDelivery({ ...late, chiefId: "chief", botId: "worker", threadId: "thread", message: `改变计划 ${tree}` })).toEqual({ kind: "conflict" });
    expect(control.rebaseChange({ ...late, note: "Reviewed the changed state and retained the user's request" }).state).toBe("pending");
    expect(control.reserve(late).state).toBe("dispatching");
    expect(control.claimDelivery({ ...late, chiefId: "chief", botId: "worker", threadId: "thread", message: `改变计划 ${tree}` }).kind).toBe("change");
    put("change-run", "completed", "[[OMB-GSD:fixture]] [[OMB-GSD-CMD:change-2]] 改变计划");
    control.attach({ ...late, assignmentId: "change-run" });
    writeFileSync(join(tree, ".planning", "ROADMAP.md"), "reviewed plan");
    expect(control.reconcile(late)).toMatchObject({ state: "uncertain" });
    expect(control.confirmChange({ ...late, note: "Reviewed the requested plan" })).toMatchObject({ state: "applied" });
    const audit = new DatabaseSync(join(dir, "goals.db"), { readOnly: true });
    try { expect(audit.prepare("SELECT kind FROM goal_gsd_command_events WHERE command_id=? ORDER BY seq").all("change-2").map(row => row.kind)).toEqual(["baseline_reviewed", "change_reviewed"]); }
    finally { audit.close(); }
    const replay = { ...base, commandId: "resume-2", kind: "resume" as const, request: "继续" };
    control.request(replay); expect(() => control.reserve(replay)).toThrow(/no confirmed/);
  } finally { control.close(); runtime.close(); goals.close(); await removeTempDir(dir); }
}, 60_000);
