import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testBase = process.env.OMB_TEST_GSD_BRIDGE === "1" ? process.env.OMB_TEST_GSD_BASE : undefined;
if (testBase && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(testBase)) throw new Error("Test endpoint must be loopback");
const base = testBase || "http://127.0.0.1:19753";
const bridge = join(root, "scripts", "gsd-bridge.mjs");
async function api(path, options) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
try {
  if (!testBase) {
    const configFile = join(root, "..", "gsd-local", "openmaus-bridge-config.json");
    if (!existsSync(configFile)) throw new Error("Run configure-gsd-bridge.mjs before installing skills");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    if (!isAbsolute(config.gitExecutable || "") || !existsSync(config.gitExecutable)) throw new Error("Configured Git executable is unavailable");
    const pkg = JSON.parse(readFileSync(join(root, "..", "intake", "gsd-core-package-v1.21.0", "package", "package.json"), "utf8"));
    if (pkg.name !== "@opengsd/gsd-core" || pkg.version !== "1.21.0") throw new Error("GSD package version mismatch");
  }
  if ((await api("/api/health")).app !== "openmausbot") throw new Error("Unexpected service on the trial port");
  const { bots } = await api("/api/bots?messages=0");
  const chiefs = bots.filter(bot => bot.chiefOfStaff && !bot.hidden);
  const workers = bots.filter(bot => !bot.hidden && !bot.chiefOfStaff && /软件开发|software (developer|engineer)/i.test(bot.title || ""));
  if (chiefs.length !== 1 || workers.length !== 1) throw new Error("Expected exactly one active chief and one coding engineer; inspect the roster first");
  const targets = [{ bot: chiefs[0], name: "openmaus-gsd-bridge" }, { bot: workers[0], name: "openmaus-gsd-worker" }];
  for (const target of targets) {
    if (target.bot.busy) throw new Error(`${target.bot.name} is busy; retry after this turn finishes`);
    target.text = readFileSync(join(root, "skills", target.name, "SKILL.md"), "utf8").replaceAll("{{OMB_GSD_BRIDGE}}", bridge);
    const listing = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills`);
    const found = listing.skills?.find(skill => skill.name === target.name);
    if (found) {
      const current = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills/${target.name}`);
      if (!found.enabled || current.text !== target.text) throw new Error(`${target.name} exists with different contents or is disabled; preserving it`);
      target.exists = true;
    }
  }
  for (const target of targets) {
    if (!target.exists) await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skill-template`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: target.name, description: `OpenMausBot GSD ${target.bot.chiefOfStaff ? "coordination" : "execution"}`, warnings: [],
        source: `local:${target.name}`, text: target.text, enabled: true }) });
    const current = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills/${target.name}`);
    const listing = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills`);
    if (current.text !== target.text || !listing.skills.some(skill => skill.name === target.name && skill.enabled)) throw new Error(`${target.name} readback failed`);
  }
  console.log(JSON.stringify({ ok: true, chief: chiefs[0].name, worker: workers[0].name, skills: targets.map(target => ({ name: target.name, existed: !!target.exists })) }));
} catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
