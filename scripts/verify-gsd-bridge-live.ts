import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const output = process.env.OMB_GSD_VERIFY_OUTPUT, cli = process.env.OMB_VERIFY_CODEX_CLI, auth = process.env.OMB_VERIFY_CODEX_AUTH;
if (!output || !cli || !auth) throw new Error("Set an isolated output directory, Codex CLI and login file.");
if (existsSync(output)) throw new Error("The isolated output directory already exists.");
mkdirSync(output, { recursive: true });
const repo = join(output, "synthetic-repo"), bridgeState = join(output, "bridge-state");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init"); writeFileSync(join(repo, "README.md"), "Synthetic fixture.\n"); git("add", "README.md");
git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial");
const bridge = join(process.cwd(), "scripts", "gsd-bridge.mjs");
const prepared = JSON.parse(execFileSync(process.execPath, [bridge, "prepare", "--repository", repo, "--task", "live-fixture"],
  { encoding: "utf8", env: { ...process.env, OMB_GSD_STATE_DIR: bridgeState }, timeout: 120_000 }));
const fixture = await launchVerificationServer({ ...process.env, OMB_VERIFY_ALLOW_PROXY: "1", OMB_GSD_STATE_DIR: bridgeState },
  undefined, undefined, undefined, undefined, undefined, ["codex"]);
const evidence: Record<string, unknown> = { version: prepared.gsdVersion, prepared: prepared.state, sourceCommit: prepared.baseCommit };
try {
  const codexHome = join(fixture.info.dataDir, ".codex"); mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(codexHome, "auth.json")); writeFileSync(join(codexHome, "config.toml"), "");
  const api = fixtureApi(fixture.info.url);
  await api("PATCH", "/api/instances/codex", { cli });
  const bot = (await api("POST", "/api/bots", { name: "GSD synthetic coder", modelSelection: { instanceId: "codex", model: process.env.OMB_VERIFY_CODEX_MODEL || "gpt-6.1-sol" },
    settings: { cwd: prepared.worktree, approvalMode: "full" } })).bot;
  const prompt = "Use the installed GSD $gsd-fast workflow. Read .codex/skills/gsd-fast/SKILL.md and follow it. This is a synthetic local fixture: create fixture-result.txt containing exactly this text including the period: \"GSD fixture complete.\" Do not access the network, commit, push, or touch any other directory. Report what you did.";
  const run = await runControlOmb(["run", "--bot", bot.id, "--text", prompt, "--url", fixture.info.url, "--wait", "job", "--timeout", "5m"]);
  evidence.run = run;
  evidence.runCompleted = (run as { ok?: boolean }).ok === true;
  evidence.gsdSkillRead = ((run as { messages?: Array<{ role?: string; kind?: string; tool?: { name?: string; ok?: boolean } }> }).messages ?? [])
    .some(message => message.role === "bot" && message.kind === "activity" && message.tool?.ok === true && message.tool.name?.includes("gsd-fast/SKILL.md"));
  const resultPath = join(prepared.worktree, "fixture-result.txt");
  evidence.outputMatches = existsSync(resultPath) && readFileSync(resultPath, "utf8").trim() === "GSD fixture complete.";
  evidence.sourceUntouched = !existsSync(join(repo, "fixture-result.txt")) && !existsSync(join(repo, ".codex"));
  const status = JSON.parse(execFileSync(process.execPath, [bridge, "status", "--task", "live-fixture"],
    { encoding: "utf8", env: { ...process.env, OMB_GSD_STATE_DIR: bridgeState }, timeout: 60_000 }));
  evidence.bridgeStatus = { state: status.state, untrackedCount: status.untrackedCount, head: status.head };
  writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ outputMatches: evidence.outputMatches, sourceUntouched: evidence.sourceUntouched, bridgeStatus: evidence.bridgeStatus }));
  if (!evidence.runCompleted || !evidence.gsdSkillRead || !evidence.outputMatches || !evidence.sourceUntouched) throw new Error("Isolated GSD execution did not produce the expected result.");
} finally { await fixture.close(); }
