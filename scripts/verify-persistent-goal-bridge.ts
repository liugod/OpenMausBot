import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" });
try {
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { label: "isolated goal runtime test", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated test" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  const lead = (await owner("POST", "/api/bots", { name: "Synthetic goal lead" })).bot;
  const area = await owner("POST", "/api/persistent-work/areas", { name: "Synthetic area" });
  const stream = await owner("POST", "/api/persistent-work/workstreams", { areaId: area.id, name: "Synthetic project", kind: "project" });
  const input = { commandId: "fixture-goal-command", workstreamId: stream.id, leadBotId: lead.id,
    title: "Synthetic goal", request: "Create a small synthetic result for the isolated fixture.", executionLimit: 5 };
  const first = await owner("POST", "/api/persistent-work/goals", input);
  const second = await owner("POST", "/api/persistent-work/goals", input);
  if (first.goalId !== second.goalId) throw new Error("goal creation is not idempotent");
  let goal = await owner("GET", `/api/persistent-work/goals/${first.goalId}`);
  if (goal.managementAttempts.length !== 1 || goal.leadBotId !== lead.id) throw new Error("planning assignment missing or duplicated");
  const deadline = Date.now() + 45_000;
  while (goal.managementAttempts[0].status === "prepared" && Date.now() < deadline) {
    await delay(1000);
    goal = await owner("GET", `/api/persistent-work/goals/${first.goalId}`);
  }
  if (goal.managementAttempts[0].status === "prepared") throw new Error("planning assignment was not dispatched");
  const ongoing = await owner("POST", "/api/persistent-work/workstreams", { areaId: area.id, name: "Synthetic ongoing", kind: "ongoing" });
  await owner("PUT", "/api/persistent-work/budgets/global", { limit: 10 });
  await owner("PUT", "/api/persistent-work/budgets/period", { workstreamId: ongoing.id, periodKey: "fixture-period", limit: 5 });
  const itemInput = { commandId: "fixture-item-command", workstreamId: ongoing.id, assigneeBotId: lead.id, title: "Synthetic item",
    brief: "Create a synthetic file.", executionLimit: 3, budgetPeriod: "fixture-period",
    criteria: [{ id: "file", description: "File exists", required: true, kind: "artifact_exists", config: { logicalName: "result" } }] };
  const item = await owner("POST", "/api/persistent-work/items", itemInput);
  const repeatedItem = await owner("POST", "/api/persistent-work/items", itemInput);
  if (item.itemId !== repeatedItem.itemId) throw new Error("standalone item was duplicated");
  const itemView = await owner("GET", `/api/persistent-work/items/${item.itemId}`);
  if (itemView.workstreamId !== ongoing.id || "goalId" in itemView) throw new Error("standalone item leaked a business goal");
  const hiddenContainer = await fetch(`${fixture.info.url}/api/persistent-work/goals/${item.itemId}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (hiddenContainer.status !== 404) throw new Error("internal execution container was exposed as a goal");
  const caps = await owner("GET", "/api/persistent-work/capabilities");
  if (!caps.chatTasks) throw new Error("chat task capability missing");
  const chatInput = { commandId: "fixture-chat-command", botId: lead.id, threadId: lead.threadId,
    request: "Create a synthetic chat task file.", executionLimit: 3 };
  const chat = await owner("POST", "/api/persistent-work/chat-tasks", chatInput);
  const chatRetry = await owner("POST", "/api/persistent-work/chat-tasks", chatInput);
  if (chat.itemId !== chatRetry.itemId) throw new Error("chat task was duplicated");
  const overview = await owner("GET", "/api/persistent-work/overview");
  if (!overview.items.some((entry: { itemId?: string; sourceThreadId?: string }) => entry.itemId === chat.itemId && entry.sourceThreadId === lead.threadId)) throw new Error("chat task is not bound to its source thread");
  const forged = await fetch(`${fixture.info.url}/api/persistent-work/chat-tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ ...chatInput, commandId: "forged-thread", threadId: "another-thread" }) });
  if (forged.ok) throw new Error("chat task accepted an unowned source thread");
  const denied = await fetch(`${fixture.info.url}/api/internal/persistent-goals/goal_context`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (denied.ok) throw new Error("internal goal tool accepted an unauthenticated request");
  console.log(JSON.stringify({ ok: true, idempotent: true, standaloneIdempotent: true, chatIdempotent: true, planningAttempts: goal.managementAttempts.length, planningStatus: goal.managementAttempts[0].status, unauthorizedStatus: denied.status }));
} finally { await fixture.close(); }
