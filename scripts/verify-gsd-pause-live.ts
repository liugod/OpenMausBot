import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";
import { openGoalStore } from "../server/goals/goal-store.ts";
import { openGsdControl } from "../server/goals/gsd-control.ts";

const output = process.env.OMB_GSD_VERIFY_OUTPUT, cli = process.env.OMB_VERIFY_CODEX_CLI, auth = process.env.OMB_VERIFY_CODEX_AUTH;
if (!output || !cli || !auth || existsSync(output)) throw new Error("A new isolated output directory, Codex CLI and login file are required.");
mkdirSync(output, { recursive: true });
const repo = join(output, "synthetic-repo"); mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init"); writeFileSync(join(repo, "README.md"), "Synthetic pause fixture.\n");
writeFileSync(join(repo, "fixture-hold.cjs"), "const fs=require('fs');const end=Date.now()+480000;const t=setInterval(()=>{if(fs.existsSync('fixture-gate')||Date.now()>end){clearInterval(t);process.exit(0)}},500);\n");
git("add", "README.md", "fixture-hold.cjs"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial");
const fixture = await launchVerificationServer({ ...process.env, OMB_VERIFY_ALLOW_PROXY: "1", OMB_TEST_GSD_BRIDGE: "1", OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" },
  undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
const taskId = "pause-fixture", state = join(fixture.info.dataDir, "gsd-integration"), evidence: Record<string, unknown> = {};
const save = () => writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
try {
  const codexHome = join(fixture.info.dataDir, ".codex"); mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(codexHome, "auth.json")); writeFileSync(join(codexHome, "config.toml"), "");
  const api = fixtureApi(fixture.info.url), env = { ...process.env, OMB_GSD_STATE_DIR: state, OMB_TEST_GSD_BRIDGE: "1", OMB_TEST_GSD_BASE: fixture.info.url };
  const bridge = join(process.cwd(), "scripts", "gsd-bridge.mjs"), goalScript = join(process.cwd(), "scripts", "gsd-create-goal.ts"), controlScript = join(process.cwd(), "scripts", "gsd-control.ts");
  const prepared = JSON.parse(execFileSync(process.execPath, [bridge, "prepare", "--repository", repo, "--task", taskId], { env, encoding: "utf8", timeout: 120_000 }));
  mkdirSync(join(prepared.worktree, ".planning"));
  writeFileSync(join(prepared.worktree, ".planning", "ROADMAP.md"), "# Roadmap\n\n### Phase 1: Fixture\n**Goal**: Exercise pause and resume.\n");
  writeFileSync(join(prepared.worktree, ".planning", "STATE.md"), "# State\n\nCurrent phase: 1\nStatus: in progress\n");
  await api("PATCH", "/api/instances/codex", { cli });
  const modelSelection = { instanceId: "codex", model: process.env.OMB_VERIFY_CODEX_MODEL || "gpt-6.1-sol" };
  const chief = (await api("GET", "/api/bots?messages=0")).bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
  const worker = (await api("POST", "/api/bots", { name: "Pause fixture worker", title: "Software engineer", modelSelection, settings: { approvalMode: "full" } })).bot;
  const goals = openGoalStore(join(fixture.info.dataDir, "goals.db"));
  try { goals.createGsdGoal({ taskId, ownerId: "local-owner", title: "Pause fixture", request: "Exercise GSD pause", leadBotId: chief.id, leadThreadId: chief.threadId }); }
  finally { goals.close(); }
  for (const [bot, name] of [[chief, "openmaus-gsd-bridge"], [worker, "openmaus-gsd-worker"]] as const) {
    const text = readFileSync(join(process.cwd(), "skills", name, "SKILL.md"), "utf8").replaceAll("{{OMB_GSD_BRIDGE}}", bridge).replaceAll("{{OMB_GSD_GOAL}}", goalScript).replaceAll("{{OMB_GSD_CONTROL}}", controlScript);
    await api("POST", `/api/bots/${bot.id}/skill-template`, { name, description: "GSD pause fixture", warnings: [], source: `local:${name}`, text, enabled: true });
  }
  const work = `[[OMB-GSD:${taskId}]] This is an isolated fixture. Use openmaus-gsd-worker in ${prepared.worktree}, follow the existing GSD work context, then run node fixture-hold.cjs from that worktree until fixture-gate appears. Do not commit, push or use the network. Stop at the next safe checkpoint when asked.`;
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [chief.id]: { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [worker.id], thread: "new", message: work } }], reply: "Sent", resumeReply: "Worker returned" } }));
  await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Start the isolated pause fixture", "--url", fixture.info.url]);
  let active = false;
  for (let i = 0; i < 90; i++) {
    const c = openGsdControl(fixture.info.dataDir); try { active = c.inspect(taskId, "local-owner").run?.status === "running"; } finally { c.close(); }
    if (active) break; await delay(1000);
  }
  if (!active) throw new Error("Real worker did not start");
  let chiefUpdated = false;
  for (let i = 0; i < 60; i++) {
    try { await api("PATCH", `/api/bots/${chief.id}`, { modelSelection, approvalMode: "full" }); chiefUpdated = true; break; }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("the bot is working")) throw error; await delay(1000); }
  }
  if (!chiefUpdated) throw new Error("Fixture chief did not become idle for model change");
  const pausePromise = runControlOmb(["run", "--bot", chief.id, "--task", chief.threadId, "--text", `This is an isolated fixture. Please pause GSD task ${taskId} safely using your openmaus-gsd-bridge control procedure; do not commit or push.`, "--url", fixture.info.url, "--wait", "job", "--timeout", "15m"]);
  let sent = false;
  for (let i = 0; i < 360; i++) {
    const c = openGsdControl(fixture.info.dataDir); try { sent = c.inspect(taskId, "local-owner").commands.some(command => command.kind === "pause" && ["sent", "applied"].includes(command.state)); } finally { c.close(); }
    if (sent) break; await delay(1000);
  }
  writeFileSync(join(prepared.worktree, "fixture-gate"), "released by isolated test\n");
  const result = await pausePromise; evidence.run = result;
  const control = openGsdControl(fixture.info.dataDir);
  try { control.reconcileSent(); evidence.control = control.inspect(taskId, "local-owner"); } finally { control.close(); }
  const commands = (evidence.control as { commands: { kind: string; state: string }[] }).commands;
  evidence.pauseConfirmed = commands.some(command => command.kind === "pause" && command.state === "applied");
  evidence.sourceUntouched = !existsSync(join(repo, "fixture-gate")) && !existsSync(join(repo, ".planning"));
  if (!sent || !evidence.pauseConfirmed || !evidence.sourceUntouched) throw new Error("Real GSD pause was not fully verified");
  await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", `This is an isolated fixture. Please resume GSD task ${taskId} using the registered handoff and your openmaus-gsd-bridge control procedure. Do not commit or push.`, "--url", fixture.info.url]);
  let resumeStarted = false, resumeSkillRead = false;
  for (let i = 0; i < 600; i++) {
    const c = openGsdControl(fixture.info.dataDir); let workerThread: string | undefined;
    try { const current = c.inspect(taskId, "local-owner"); resumeStarted = current.commands.some(command => command.kind === "resume" && command.state === "applied"); workerThread = current.run?.threadId; }
    finally { c.close(); }
    if (resumeStarted && workerThread) {
      const messages = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
      try { resumeSkillRead = !!messages.prepare("SELECT 1 FROM messages WHERE thread_id=? AND kind='activity' AND (json LIKE '%gsd-resume-work%' OR json LIKE '%resume-project.md%') LIMIT 1").get(workerThread); }
      finally { messages.close(); }
    }
    if (resumeStarted && resumeSkillRead) break;
    await delay(1000);
  }
  evidence.resumeStarted = resumeStarted; evidence.resumeSkillRead = resumeSkillRead;
  save(); console.log(JSON.stringify({ pauseSent: sent, pauseConfirmed: evidence.pauseConfirmed, resumeStarted, resumeSkillRead, sourceUntouched: evidence.sourceUntouched }));
  if (!resumeStarted || !resumeSkillRead) throw new Error("Real GSD resume was not fully verified");
} catch (error) { evidence.error = error instanceof Error ? error.message : String(error); save(); throw error; }
finally { await fixture.close(); }
