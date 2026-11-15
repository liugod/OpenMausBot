import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("exposes the installed GSD bridge skill to an isolated OpenMaus chief turn", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const chief = (await api("GET", "/api/bots")).body.bots[0];
    expect(chief.chiefOfStaff).toBe(true);
    const worker = (await api("POST", "/api/bots", { name: "Fixture coding worker", title: "软件开发工程师" })).body.bot;
    const install = () => spawnSync(process.execPath, [join(process.cwd(), "scripts", "install-gsd-bridge.mjs")], { encoding: "utf8", windowsHide: true,
      env: { ...process.env, OMB_TEST_GSD_BRIDGE: "1", OMB_TEST_GSD_BASE: fixture.info.url }, timeout: 30_000 });
    const installed = install();
    expect(installed.status, installed.stderr).toBe(0);
    const repeated = install();
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).skills.every((item: { existed: boolean }) => item.existed)).toBe(true);
    const listing = await api("GET", `/api/bots/${chief.id}/skills`);
    expect(listing.body.skills.some((item: { name: string; enabled: boolean }) => item.name === "openmaus-gsd-bridge" && item.enabled)).toBe(true);
    const workerListing = await api("GET", `/api/bots/${worker.id}/skills`);
    expect(workerListing.body.skills.some((item: { name: string; enabled: boolean }) => item.name === "openmaus-gsd-worker" && item.enabled)).toBe(true);
    await control(["send", "--bot", chief.id, "--text", "Use GSD for the isolated test."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string };
    expect(launched.systemPrompt).toContain("openmaus-gsd-bridge");
    await control(["interrupt", "--bot", chief.id]);
  } finally { await fixture.close(); }
}, 120_000);
