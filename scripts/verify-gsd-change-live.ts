import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";
import { openGoalStore } from "../server/goals/goal-store.ts";
import { openGsdControl } from "../server/goals/gsd-control.ts";

const output = process.env.OMB_GSD_VERIFY_OUTPUT, cli = process.env.OMB_VERIFY_CODEX_CLI, auth = process.env.OMB_VERIFY_CODEX_AUTH;
if (!output || !cli || !auth || existsSync(output)) throw new Error("A new isolated output directory, Codex CLI and login file are required.");
mkdirSync(output, { recursive: true });
const repo = join(output, "synthetic-repo"); mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init"); writeFileSync(join(repo, "README.md"), "Synthetic fixture.\n"); git("add", "README.md");
git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial");
const fixture = await launchVerificationServer({ ...process.env, OMB_VERIFY_ALLOW_PROXY: "1", OMB_TEST_GSD_BRIDGE: "1", OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" },
  undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
const taskId = "reverse-fixture", state = join(fixture.info.dataDir, "gsd-integration"), evidence: Record<string, unknown> = {};
const save = () => writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
try {
  const codexHome = join(fixture.info.dataDir, ".codex"); mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(codexHome, "auth.json")); writeFileSync(join(codexHome, "config.toml"), "");
  const api = fixtureApi(fixture.info.url), env = { ...process.env, OMB_GSD_STATE_DIR: state, OMB_TEST_GSD_BRIDGE: "1", OMB_TEST_GSD_BASE: fixture.info.url };
  const bridge = join(process.cwd(), "scripts", "gsd-bridge.mjs"), goalScript = join(process.cwd(), "scripts", "gsd-create-goal.ts"), controlScript = join(process.cwd(), "scripts", "gsd-control.ts");
  const prepared = JSON.parse(execFileSync(process.execPath, [bridge, "prepare", "--repository", repo, "--task", taskId], { env, encoding: "utf8", timeout: 120_000 }));
  mkdirSync(join(prepared.worktree, ".planning"));
  writeFileSync(join(prepared.worktree, ".planning", "ROADMAP.md"), "# Roadmap\n\n### Phase 1: Foundation\n**Goal**: Prepare the fixture.\n");
  writeFileSync(join(prepared.worktree, ".planning", "REQUIREMENTS.md"), "# Requirements\n\n- Prepare the fixture.\n");
  writeFileSync(join(prepared.worktree, ".planning", "STATE.md"), "# State\n\nCurrent phase: 1\nStatus: planned\n");
  const chief = (await api("GET", "/api/bots?messages=0")).bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
  const worker = (await api("POST", "/api/bots", { name: "Fixture coding worker", title: "Software engineer" })).bot;
  const goals = openGoalStore(join(fixture.info.dataDir, "goals.db"));
  try { goals.createGsdGoal({ taskId, ownerId: "local-owner", title: "Synthetic plan", request: "Maintain fixture plan", leadBotId: chief.id, leadThreadId: chief.threadId }); }
  finally { goals.close(); }
  const plan = { [chief.id]: { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [worker.id], thread: "new", message: `[[OMB-GSD:${taskId}]] Review the synthetic fixture at ${prepared.worktree}` } }], reply: "Sent", resumeReply: "Done" },
    [worker.id]: { reply: "Synthetic baseline complete" } };
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify(plan));
  await runControlOmb(["run", "--bot", chief.id, "--task", chief.threadId, "--text", "Prepare the synthetic fixture", "--url", fixture.info.url, "--wait", "job", "--timeout", "60s"]);
  let registered = false;
  for (let i = 0; i < 30; i++) {
    const c = openGsdControl(fixture.info.dataDir);
    try { registered = c.inspect(taskId, "local-owner").run?.status === "completed"; } finally { c.close(); }
    if (registered) break; await delay(1000);
  }
  if (!registered) throw new Error("Synthetic baseline assignment did not complete and register");
  await api("PATCH", "/api/instances/codex", { cli });
  const model = { instanceId: "codex", model: process.env.OMB_VERIFY_CODEX_MODEL || "gpt-6.1-sol" };
  for (const [bot, name] of [[chief, "openmaus-gsd-bridge"], [worker, "openmaus-gsd-worker"]] as const) {
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: model, approvalMode: "full" });
    const text = readFileSync(join(process.cwd(), "skills", name, "SKILL.md"), "utf8").replaceAll("{{OMB_GSD_BRIDGE}}", bridge).replaceAll("{{OMB_GSD_GOAL}}", goalScript).replaceAll("{{OMB_GSD_CONTROL}}", controlScript);
    await api("POST", `/api/bots/${bot.id}/skill-template`, { name, description: "GSD reverse fixture", warnings: [], source: `local:${name}`, text, enabled: true });
  }
  const prompt = `This is an isolated synthetic test. For GSD task ${taskId}, use your openmaus-gsd-bridge change procedure and gsd-control. Change the existing roadmap by adding exactly one new phase titled "Access Control" with goal "Define access rules". This is a planning-only request; do not implement, commit, push or use the network. Ask the registered fixture worker in its existing thread to make the change, then review the actual roadmap against this request and record the review. Do not say complete without the real worker result.`;
  const result = await runControlOmb(["run", "--bot", chief.id, "--task", chief.threadId, "--text", prompt, "--url", fixture.info.url, "--wait", "job", "--timeout", "15m"]);
  evidence.run = result;
  const control = openGsdControl(fixture.info.dataDir);
  try { evidence.control = control.inspect(taskId, "local-owner"); } finally { control.close(); }
  const roadmap = readFileSync(join(prepared.worktree, ".planning", "ROADMAP.md"), "utf8");
  evidence.planContainsRequest = /Access Control/i.test(roadmap) && /Define access rules/i.test(roadmap);
  evidence.sourceUntouched = !existsSync(join(repo, ".planning"));
  const controls = (evidence.control as { commands: { kind: string; state: string }[] }).commands;
  evidence.changeReviewed = controls.some(command => command.kind === "change" && command.state === "applied");
  evidence.chiefCompleted = (result as { ok?: boolean }).ok === true;
  save(); console.log(JSON.stringify({ planContainsRequest: evidence.planContainsRequest, sourceUntouched: evidence.sourceUntouched, changeReviewed: evidence.changeReviewed, chiefCompleted: evidence.chiefCompleted }));
  if (!evidence.planContainsRequest || !evidence.sourceUntouched || !evidence.changeReviewed || !evidence.chiefCompleted) throw new Error("Real GSD change was not fully verified");
} catch (error) { evidence.error = error instanceof Error ? error.message : String(error); save(); throw error; }
finally { await fixture.close(); }
