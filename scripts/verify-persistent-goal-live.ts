import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const cli = process.env.OMB_VERIFY_CODEX_CLI, auth = process.env.OMB_VERIFY_CODEX_AUTH;
const output = process.env.OMB_VERIFY_OUTPUT, model = process.env.OMB_VERIFY_CODEX_MODEL;
if (!cli || !auth || !output || !model) throw new Error("Set CLI, sign-in file, output directory and model for the isolated fixture.");
mkdirSync(output, { recursive: true });
const fixture = await launchVerificationServer({ ...process.env, OMB_VERIFY_ALLOW_PROXY: "1", OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
const record: Record<string, unknown> = { model, fixtureUrl: fixture.info.url, startedAt: new Date().toISOString(), states: [] };
const save = () => writeFileSync(join(output, "persistent-goal-live.json"), JSON.stringify(record, null, 2));
try {
  const home = join(fixture.info.dataDir, ".codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(home, "auth.json")); chmodSync(join(home, "auth.json"), 0o600);
  writeFileSync(join(home, "config.toml"), "");
  const api = fixtureApi(fixture.info.url);
  await api("PATCH", "/api/instances/codex", { cli });
  const lead = (await api("POST", "/api/bots", { name: "Synthetic Goal Lead", description: "Plan and review the synthetic goal.", modelSelection: { instanceId: "codex", model } })).bot;
  const pairing = await api("POST", "/api/auth/pairing", { label: "isolated goal acceptance", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated test" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  const area = await owner("POST", "/api/persistent-work/areas", { name: "Synthetic area" });
  const stream = await owner("POST", "/api/persistent-work/workstreams", { areaId: area.id, name: "Synthetic project", kind: "project" });
  const goal = await owner("POST", "/api/persistent-work/goals", { commandId: "live-goal-1", workstreamId: stream.id, leadBotId: lead.id,
    title: "Create synthetic result", request: `Create one plain text output file named result.txt containing exactly the sentence Synthetic goal verified. Assign the task to bot ${lead.id}. Require the artifact_exists criterion with logicalName result and a lead_review criterion that checks only the exact file content.`, executionLimit: 8 });
  record.goalId = goal.goalId; save();
  const deadline = Date.now() + Math.min(720_000, Math.max(30_000, Number(process.env.OMB_VERIFY_TIMEOUT_MS) || 720_000));
  let last = "";
  while (Date.now() < deadline) {
    const state = await owner("GET", `/api/persistent-work/goals/${goal.goalId}`);
    const compact = { status: state.status, version: state.version, management: state.managementAttempts.map((x: any) => x.status),
      tasks: state.tasks.map((x: any) => ({ id: x.id, status: x.status, blocker: x.blocker })),
      reviews: state.reviewAttempts.map((x: any) => x.status), artifacts: state.artifacts.length, checks: state.checks.length };
    const text = JSON.stringify(compact);
    if (text !== last) { (record.states as unknown[]).push(compact); save(); console.log(text); last = text; }
    if (["delivered", "failed", "blocked", "cancelled", "waiting_user"].includes(state.status) ||
      (state.tasks.length > 0 && state.tasks.every((task: any) => task.status === "succeeded"))) break;
    await delay(5000);
  }
  const state = await owner("GET", `/api/persistent-work/goals/${goal.goalId}`);
  record.goal = state;
  if (state.artifacts.length && state.tasks.every((task: any) => task.status === "succeeded")) {
    const artifact = state.artifacts[0];
    const response = await fetch(`${fixture.info.url}/api/persistent-work/goals/${goal.goalId}/artifacts/${artifact.id}`,
      { headers: { authorization: `Bearer ${session.token}` } });
    const text = await response.text();
    record.download = { status: response.status, matchesExpected: text === "Synthetic goal verified." };
    if (response.ok) writeFileSync(join(output, "project-result.txt"), text, "utf8");
    if (!response.ok || text !== "Synthetic goal verified.") throw new Error("approved goal artifact could not be downloaded");
  }
  if (state.tasks.length > 0 && state.tasks.every((task: any) => task.status === "succeeded")) {
    const secondArea = await owner("POST", "/api/persistent-work/areas", { name: "Synthetic ongoing area" });
    const ongoing = await owner("POST", "/api/persistent-work/workstreams", { areaId: secondArea.id, name: "Synthetic ongoing", kind: "ongoing" });
    await owner("PUT", "/api/persistent-work/budgets/global", { limit: 20 });
    await owner("PUT", "/api/persistent-work/budgets/period", { workstreamId: ongoing.id, periodKey: "fixture-period", limit: 8 });
    const item = await owner("POST", "/api/persistent-work/items", { commandId: "live-item-1", workstreamId: ongoing.id, assigneeBotId: lead.id,
      title: "Create a synthetic ongoing result", brief: "Create result.txt containing exactly the text Ongoing item verified. Register it as result.",
      executionLimit: 5, budgetPeriod: "fixture-period", criteria: [
        { id: "file", description: "A result file exists", required: true, kind: "artifact_exists", config: { logicalName: "result" } },
        { id: "review", description: "The file contains exactly Ongoing item verified.", required: true, kind: "lead_review", config: {} },
      ] });
    record.itemId = item.itemId; record.itemStates = []; save();
    let lastItem = "";
    while (Date.now() < deadline) {
      const current = await owner("GET", `/api/persistent-work/items/${item.itemId}`);
      const compact = { status: current.task.status, version: current.version, scopeStatus: current.status };
      const text = JSON.stringify(compact);
      if (text !== lastItem) { (record.itemStates as unknown[]).push(compact); save(); console.log(`item ${text}`); lastItem = text; }
      if (["succeeded", "blocked", "waiting_user", "cancelled"].includes(current.task.status)) break;
      await delay(5000);
    }
    const finalItem = await owner("GET", `/api/persistent-work/items/${item.itemId}`);
    record.item = finalItem;
    if (finalItem.task.status === "succeeded" && finalItem.artifacts.length) {
      const response = await fetch(`${fixture.info.url}/api/persistent-work/items/${item.itemId}/artifacts/${finalItem.artifacts[0].id}`,
        { headers: { authorization: `Bearer ${session.token}` } });
      const text = await response.text();
      record.itemDownload = { status: response.status, matchesExpected: text === "Ongoing item verified." };
      if (response.ok) writeFileSync(join(output, "ongoing-result.txt"), text, "utf8");
      if (!response.ok || text !== "Ongoing item verified.") throw new Error("approved standalone artifact could not be downloaded");
    }
    record.scope = await owner("GET", "/api/persistent-work/scopes");
    record.budgets = await owner("GET", "/api/persistent-work/budgets");
  }
  record.job = await api("GET", `/api/threads/${state.leadThreadId}/job?scope=job&since=0&full=1`);
  record.messages = await runControlOmb(["messages", "--bot", lead.id, "--task", state.leadThreadId, "--limit", "50", "--url", fixture.info.url]);
  record.timedOut = Date.now() >= deadline && !["delivered", "failed", "blocked", "cancelled", "waiting_user"].includes(state.status) &&
    !(state.tasks.length > 0 && state.tasks.every((task: any) => task.status === "succeeded"));
  record.finishedAt = new Date().toISOString(); save();
} catch (error) { record.error = String(error); record.finishedAt = new Date().toISOString(); save(); throw error; }
finally { await fixture.close(); }
