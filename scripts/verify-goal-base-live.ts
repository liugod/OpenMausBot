import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const cli = process.env.OMB_VERIFY_CODEX_CLI;
const auth = process.env.OMB_VERIFY_CODEX_AUTH;
const output = process.env.OMB_VERIFY_OUTPUT;
const model = process.env.OMB_VERIFY_CODEX_MODEL;
if (!cli || !auth || !output || !model) throw new Error("Set CLI, sign-in file, output directory and model for this real-model fixture.");
mkdirSync(output, { recursive: true });
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
const record: Record<string, unknown> = { model, startedAt: new Date().toISOString(), cases: [] };
const save = () => writeFileSync(join(output, "m0-live.json"), JSON.stringify(record, null, 2));
try {
  const home = join(fixture.info.dataDir, ".codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(home, "auth.json"));
  chmodSync(join(home, "auth.json"), 0o600);
  writeFileSync(join(home, "config.toml"), "");
  const api = fixtureApi(fixture.info.url);
  await api("PATCH", "/api/instances/codex", { cli });
  const selection = { instanceId: "codex", model };
  const lead = (await api("POST", "/api/bots", { name: "Goal Lead", description: "Coordinate named teammates and synthesize their results.", modelSelection: selection })).bot;
  const analyst = (await api("POST", "/api/bots", { name: "Analyst", description: "Analyze small synthetic planning problems.", modelSelection: selection })).bot;
  const reviewer = (await api("POST", "/api/bots", { name: "Reviewer", description: "Review small synthetic planning problems.", modelSelection: selection })).bot;
  record.bots = [lead.id, analyst.id, reviewer.id];
  const prompt = "This is an isolated coordination test. Use the native teammate tools to delegate to BOTH Analyst and Reviewer: ask Analyst for two concrete risks in a project to build a small notes app; ask Reviewer for two practical acceptance checks. Wait for both actual replies and synthesize the findings, identifying their sources. Do not use the web or send messages outside this test.";
  const sent = await runControlOmb(["send", "--bot", lead.id, "--text", prompt, "--url", fixture.info.url]);
  record.sent = sent; save();
  const deadline = Date.now() + 600_000;
  let result: any;
  do {
    result = await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30", "--url", fixture.info.url]);
    record.wait = result; save();
  } while (Date.now() < deadline && !["settled", "failed", "needs-user", "stalled"].includes(result?.status));
  record.messages = await runControlOmb(["messages", "--bot", lead.id, "--limit", "80", "--url", fixture.info.url]);
  const job = await api("GET", `/api/threads/${lead.threadId}/job?scope=job&since=0&full=1`);
  record.job = job;
  const children = Array.isArray(job.nodes) ? job.nodes.filter((node: any) => node.depth > 0 && node.status === "completed") : [];
  record.observedBoth = children.some((node: any) => node.botId === analyst.id) && children.some((node: any) => node.botId === reviewer.id);
  record.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: result?.status, observedBoth: record.observedBoth, output: join(output, "m0-live.json") }));
} catch (error) {
  record.error = String(error); record.finishedAt = new Date().toISOString(); save();
  throw error;
} finally { await fixture.close(); }
