import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { openGoalStore } from "./goals/goal-store.ts";
import { openGsdControl } from "./goals/gsd-control.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("pins actual coordinator receipts, queues one pause, and waits for worker and handoff evidence", async () => {
  const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1", OMB_TEST_GSD_BRIDGE: "1" },
    undefined, undefined, undefined, undefined, { scripted: true });
  const api = fixtureApi(fixture.info.url), taskId = "fixture-control", ownerId = "local-owner";
  const state = join(fixture.info.dataDir, "gsd-integration"), hash = createHash("sha256").update(taskId).digest("hex"), tree = join(state, "worktrees", hash);
  mkdirSync(join(tree, ".planning"), { recursive: true }); mkdirSync(join(state, "runs"), { recursive: true });
  writeFileSync(join(state, "runs", `${hash}.json`), JSON.stringify({ taskId, state: "ready", worktree: tree }));
  writeFileSync(join(tree, ".planning", "ROADMAP.md"), "# Roadmap\n\n### Phase 1: Fixture\n");
  const planPath = join(fixture.info.dataDir, "room-plan.json"), gate = join(fixture.info.dataDir, "worker-gate");
  let goals: ReturnType<typeof openGoalStore> | undefined, control: ReturnType<typeof openGsdControl> | undefined;
  try {
    const chief = (await api("GET", "/api/bots?messages=0")).bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
    const worker = (await api("POST", "/api/bots", { name: "Fixture worker" })).bot;
    goals = openGoalStore(join(fixture.info.dataDir, "goals.db"));
    const goal = goals.createGsdGoal({ taskId, ownerId, title: "Fixture", request: "Do fixture work", leadBotId: chief.id, leadThreadId: chief.threadId });
    const plan: Record<string, unknown> = {
      [chief.id]: { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [worker.id], message: `[[OMB-GSD:${taskId}]] perform fixture work in ${tree}`, thread: "new" } }], reply: "Sent", resumeReply: "Worker returned" },
      [worker.id]: { gateFile: gate, reply: "Fixture work stopped normally" },
    };
    const save = () => writeFileSync(planPath, JSON.stringify(plan)); save();
    await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Run the isolated fixture", "--url", fixture.info.url]);
    control = openGsdControl(fixture.info.dataDir);
    await expect.poll(() => control!.inspect(taskId, ownerId).run?.status, { timeout: 40_000 }).toBe("running");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === chief.id)?.busy, { timeout: 20_000 }).toBe(false);
    const registered = control.inspect(taskId, ownerId).run!;
    const pause = { taskId, ownerId, commandId: "pause-fixture", kind: "pause" as const, request: "Pause safely" };
    control.request(pause); const reserved = control.reserve(pause);
    expect(reserved).toMatchObject({ state: "dispatching", botId: worker.id, threadId: registered.threadId });
    const pauseCall = { bot_ids: [worker.id], thread: registered.threadId, message: `[[OMB-GSD:${taskId}]] [[OMB-GSD-CMD:pause-fixture]] Pause safely and write a handoff in ${tree}` };
    plan[chief.id] = { script: [{ key: "pause", match: ["Pause the fixture"], steps: [{ tool: "coordinate_bots", arguments: pauseCall }, { tool: "coordinate_bots", arguments: pauseCall, expectError: true }], reply: "Pause requested" },
      { key: "summary", match: [], repeat: true, reply: "Worker returned" }] };
    save();
    await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Pause the fixture", "--url", fixture.info.url]);
    await expect.poll(() => control!.inspect(taskId, ownerId).commands.find(c => c.id === "pause-fixture")?.state, { timeout: 40_000 }).toBe("sent");
    const observed = control.inspect(taskId, ownerId).commands.find(c => c.id === "pause-fixture")!;
    expect(observed.assignment_id).toBeTruthy();
    expect(() => control!.claimDelivery({ ...pause, chiefId: chief.id, botId: worker.id, threadId: registered.threadId, message: `Pause safely ${tree}` })).toThrow();
    writeFileSync(join(tree, ".planning", "HANDOFF.json"), '{"version":"1.0","timestamp":"fixture","status":"paused","async_jobs":[]}');
    writeFileSync(gate, "finish");
    await expect.poll(() => { control!.reconcileSent(); return control!.inspect(taskId, ownerId).commands.find(c => c.id === "pause-fixture")?.state; }, { timeout: 45_000 }).toBe("applied");
    expect(readHandoffs(fixture.info.dataDir).filter((row: { text?: string }) => row.text?.includes("[[OMB-GSD-CMD:pause-fixture]]"))).toHaveLength(1);
    expect(goals.read(goal.goalId, ownerId)?.gsd?.controls).toEqual(expect.arrayContaining([expect.objectContaining({ id: "pause-fixture", state: "applied" })]));
    await expect.poll(async () => { const bot = (await api("GET", "/api/bots?messages=0")).bots.find((item: { id: string }) => item.id === chief.id); return !bot.busy && !bot.waitingForTeammates; }, { timeout: 40_000 }).toBe(true);
    const resume = { taskId, ownerId, commandId: "resume-fixture", kind: "resume" as const, request: "Resume safely" };
    control.request(resume); expect(control.reserve(resume).state).toBe("dispatching");
    const resumeGate = join(fixture.info.dataDir, "resume-gate");
    plan[chief.id] = { script: [{ key: "resume", match: ["Resume the fixture"], steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [worker.id], thread: registered.threadId,
      message: `[[OMB-GSD:${taskId}]] [[OMB-GSD-CMD:resume-fixture]] Resume safely using the handoff in ${tree}` } }], reply: "Resume requested" }, { key: "summary", match: [], repeat: true, reply: "Worker returned" }] };
    plan[worker.id] = { gateFile: resumeGate, reply: "Resumed fixture work" }; save();
    await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Resume the fixture", "--url", fixture.info.url]);
    await expect.poll(() => { control!.reconcileSent(); return control!.inspect(taskId, ownerId).commands.find(c => c.id === "resume-fixture")?.state; }, { timeout: 45_000 }).toBe("applied");
    expect(control.inspect(taskId, ownerId).run?.status).toBe("running");
    writeFileSync(resumeGate, "finish");
    await expect.poll(() => control!.inspect(taskId, ownerId).run?.status, { timeout: 45_000 }).toBe("completed");
    await expect.poll(async () => { const bot = (await api("GET", "/api/bots?messages=0")).bots.find((item: { id: string }) => item.id === chief.id); return !bot.busy && !bot.waitingForTeammates; }, { timeout: 40_000 }).toBe(true);
    const change = { taskId, ownerId, commandId: "change-fixture", kind: "change" as const, request: "Add access control" };
    control.request(change); expect(control.reserve(change).state).toBe("dispatching");
    const changeGate = join(fixture.info.dataDir, "change-gate");
    plan[chief.id] = { script: [{ key: "change", match: ["Change the fixture"], steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [worker.id], thread: registered.threadId,
      message: `[[OMB-GSD:${taskId}]] [[OMB-GSD-CMD:change-fixture]] Add access control to the roadmap in ${tree}` } }], reply: "Change requested" }, { key: "summary", match: [], repeat: true, reply: "Worker returned" }] };
    plan[worker.id] = { gateFile: changeGate, reply: "Updated fixture plan" }; save();
    await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Change the fixture", "--url", fixture.info.url]);
    await expect.poll(() => control!.inspect(taskId, ownerId).commands.find(c => c.id === "change-fixture")?.state, { timeout: 45_000 }).toBe("sent");
    writeFileSync(join(tree, ".planning", "ROADMAP.md"), "# Roadmap\n\n### Phase 1: Access control\n");
    writeFileSync(changeGate, "finish");
    await expect.poll(() => { control!.reconcileSent(); return control!.inspect(taskId, ownerId).commands.find(c => c.id === "change-fixture")?.state; }, { timeout: 45_000 }).toBe("uncertain");
    expect(control.confirmChange({ ...change, note: "Verified the requested access-control phase in the roadmap" }).state).toBe("applied");
  } finally { control?.close(); goals?.close(); await fixture.close(); }
}, 180_000);
