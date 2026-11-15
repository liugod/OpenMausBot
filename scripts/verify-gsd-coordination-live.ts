import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const output = process.env.OMB_GSD_VERIFY_OUTPUT, cli = process.env.OMB_VERIFY_CODEX_CLI, auth = process.env.OMB_VERIFY_CODEX_AUTH;
if (!output || !cli || !auth || existsSync(output)) throw new Error("A new isolated output directory, Codex CLI and login file are required.");
mkdirSync(output, { recursive: true });
const repo = join(output, "synthetic-repo"); mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init"); writeFileSync(join(repo, "README.md"), "Synthetic fixture.\n"); git("add", "README.md");
git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial");
const fixture = await launchVerificationServer({ ...process.env, OMB_VERIFY_ALLOW_PROXY: "1", OMB_TEST_GSD_BRIDGE: "1" },
  undefined, undefined, undefined, undefined, undefined, ["codex"]);
const bridge = join(process.cwd(), "scripts", "gsd-bridge.mjs"), taskId = "coordinated-fixture-1";
const evidence: Record<string, unknown> = {};
const save = () => writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
try {
  const codexHome = join(fixture.info.dataDir, ".codex"); mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(codexHome, "auth.json")); writeFileSync(join(codexHome, "config.toml"), "");
  const api = fixtureApi(fixture.info.url);
  await api("PATCH", "/api/instances/codex", { cli });
  const modelSelection = { instanceId: "codex", model: process.env.OMB_VERIFY_CODEX_MODEL || "gpt-6.1-sol" };
  const chief = (await api("POST", "/api/bots", { name: "GSD fixture chief", chiefOfStaff: true, modelSelection, settings: { approvalMode: "full" } })).bot;
  const worker = (await api("POST", "/api/bots", { name: "GSD fixture worker", title: "Coding engineer", modelSelection, settings: { approvalMode: "full" } })).bot;
  for (const [bot, name] of [[chief, "openmaus-gsd-bridge"], [worker, "openmaus-gsd-worker"]] as const) {
    const text = readFileSync(join(process.cwd(), "skills", name, "SKILL.md"), "utf8").replaceAll("{{OMB_GSD_BRIDGE}}", bridge);
    await api("POST", `/api/bots/${bot.id}/skill-template`, { name, description: "GSD integration fixture", warnings: [], source: `local:${name}`, text, enabled: true });
  }
  const prompt = `This is an isolated synthetic test. Use your openmaus-gsd-bridge skill to prepare GSD for repository ${repo} with task ID ${taskId}, then explicitly use coordinate_bots to assign the work to GSD fixture worker. Tell the worker to use its openmaus-gsd-worker skill and the installed gsd-fast workflow in the prepared worktree: create fixture-result.txt containing exactly "GSD fixture complete." including the period. There is no byte-length requirement; follow the literal text if any calculated length differs. Do not access the network, commit, push or modify the source repository. Wait for the worker's actual result and report it.`;
  const run = await runControlOmb(["run", "--bot", chief.id, "--text", prompt, "--url", fixture.info.url, "--wait", "job", "--timeout", "8m"]);
  evidence.run = run;
  const stateRoot = join(fixture.info.dataDir, "gsd-integration");
  const status = JSON.parse(execFileSync(process.execPath, [bridge, "status", "--task", taskId],
    { encoding: "utf8", env: { ...process.env, OMB_GSD_STATE_DIR: stateRoot }, timeout: 60_000 }));
  evidence.status = status;
  const resultPath = join(status.worktree, "fixture-result.txt");
  evidence.outputMatches = existsSync(resultPath) && readFileSync(resultPath, "utf8").trim() === "GSD fixture complete.";
  evidence.sourceUntouched = !existsSync(join(repo, "fixture-result.txt")) && !existsSync(join(repo, ".codex"));
  const nodes = (run as { job?: { nodes?: Array<{ botId?: string; status?: string }> }; ok?: boolean }).job?.nodes ?? [];
  evidence.workerCompleted = nodes.some(node => node.botId === worker.id && node.status === "completed");
  evidence.chiefCompleted = (run as { ok?: boolean }).ok === true;
  if (existsSync(resultPath)) copyFileSync(resultPath, join(output, "fixture-result.txt"));
  save();
  console.log(JSON.stringify({ outputMatches: evidence.outputMatches, sourceUntouched: evidence.sourceUntouched,
    workerCompleted: evidence.workerCompleted, chiefCompleted: evidence.chiefCompleted }));
  if (!evidence.outputMatches || !evidence.sourceUntouched || !evidence.workerCompleted || !evidence.chiefCompleted) throw new Error("Coordinated fixture did not complete all required steps.");
} catch (error) { evidence.error = error instanceof Error ? error.message : String(error); save(); throw error; }
finally { await fixture.close(); }
