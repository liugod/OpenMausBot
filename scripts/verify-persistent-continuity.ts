import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer({ OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" });
try {
  const doctor = await runControlOmb(["doctor", "--url", fixture.info.url]);
  assert.equal((doctor as { ok: boolean }).ok, true);
  const api = fixtureApi(fixture.info.url);
  const bots = await api("GET", "/api/bots");
  const pairing = await api("POST", "/api/auth/pairing", { label: "continuity fixture", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "continuity fixture" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  const area = await owner("POST", "/api/persistent-work/areas", { name: "Synthetic research" });
  const stream = await owner("POST", "/api/persistent-work/workstreams", { areaId: area.id, name: "Synthetic report", kind: "project" });
  await owner("PUT", "/api/persistent-work/budgets/global", { limit: 6 });
  const item = await owner("POST", "/api/persistent-work/items", { commandId: "fixture-create", workstreamId: stream.id,
    assigneeBotId: bots.bots[0].id, title: "Fixture continuity", brief: "Return a fixture response", executionLimit: 6,
    criteria: [{ id: "file", description: "Actual file required", kind: "artifact_exists", required: true, config: { logicalName: "result" } }] });
  const base = `/api/persistent-work/items/${encodeURIComponent(item.itemId)}`;
  const blocked = async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const state = await owner("GET", base);
      if (state.task.status === "blocked") return state;
      await delay(100);
    }
    throw new Error("fixture task did not block on missing structured output");
  };
  const first = await blocked();
  const taskPath = `${base}/tasks/${encodeURIComponent(first.task.id)}`;
  const before = await owner("GET", `${taskPath}/continuation`);
  const changed = await owner("POST", `${taskPath}/amend`, { commandId: "fixture-amend", expectedVersion: first.version,
    instruction: "Add verifiable source links", externalStateChecked: true });
  const second = await blocked();
  const after = await owner("GET", `${taskPath}/continuation`);
  assert.equal(first.task.id, second.task.id);
  assert.equal(before.taskRevision, 1);
  assert.equal(after.taskRevision, 2);
  assert.equal(second.artifacts.length, 0);
  assert.equal(second.task.criteria.length, 2);
  const budgets = await owner("GET", "/api/persistent-work/budgets");
  assert.equal(budgets.global.used, 2);
  const evidence = { doctor: true, itemId: item.itemId, taskId: first.task.id, firstStatus: first.task.status,
    secondStatus: second.task.status, taskRevisions: [before.taskRevision, after.taskRevision], affectedTaskIds: changed.affectedTaskIds,
    cumulativeExecutions: budgets.global.used, missingOutputRejected: true, logPath: fixture.info.logPath };
  if (process.env.OMB_VERIFY_OUTPUT) writeFileSync(process.env.OMB_VERIFY_OUTPUT, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await fixture.close(); }
