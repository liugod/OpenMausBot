import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testBase = process.env.OMB_TEST_GSD_BRIDGE === "1" ? process.env.OMB_TEST_GSD_BASE : undefined;
if (testBase && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(testBase)) throw new Error("Test endpoint must be loopback");
const base = testBase || "http://127.0.0.1:19753";
const bridge = join(root, "scripts", "gsd-bridge.mjs");
const goal = join(root, "scripts", "gsd-create-goal.ts");
const previousChiefHash = "a3dd4f7c36f8868aaa7307e287a9ac944f8cfb7f93387d005ecd46034651699e";
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
    target.text = readFileSync(join(root, "skills", target.name, "SKILL.md"), "utf8").replaceAll("{{OMB_GSD_BRIDGE}}", bridge).replaceAll("{{OMB_GSD_GOAL}}", goal);
    const listing = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills`);
    const found = listing.skills?.find(skill => skill.name === target.name);
    if (found) {
      const current = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills/${target.name}`);
      if (!found.enabled) throw new Error(`${target.name} is disabled; preserving it`);
      if (current.text === target.text) target.exists = true;
      else {
        const previous = current.text.replaceAll(bridge, "{{OMB_GSD_BRIDGE}}");
        if (target.name !== "openmaus-gsd-bridge" || createHash("sha256").update(previous).digest("hex") !== previousChiefHash) throw new Error(`${target.name} has different contents; preserving it`);
        target.previous = current.text;
      }
    }
  }
  for (const target of targets) {
    const path = `/api/bots/${encodeURIComponent(target.bot.id)}`;
    const install = text => api(`${path}/skill-template`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: target.name, description: `OpenMausBot GSD ${target.bot.chiefOfStaff ? "coordination" : "execution"}`, warnings: [],
        source: `local:${target.name}`, text, enabled: true }) });
    if (!target.exists) {
      if (target.previous) await api(`${path}/skills/${target.name}`, { method: "DELETE" });
      try { await install(target.text); } catch (error) { if (target.previous) await install(target.previous); throw error; }
    }
    const current = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills/${target.name}`);
    const listing = await api(`/api/bots/${encodeURIComponent(target.bot.id)}/skills`);
    if (current.text !== target.text || !listing.skills.some(skill => skill.name === target.name && skill.enabled)) throw new Error(`${target.name} readback failed`);
  }
  console.log(JSON.stringify({ ok: true, chief: chiefs[0].name, worker: workers[0].name, skills: targets.map(target => ({ name: target.name, existed: !!target.exists })) }));
} catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
