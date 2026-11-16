import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { fixtureApi, mountPreview } from "../scripts/testing/preview-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const exec = promisify(execFile);
it("automatically syncs the GSD roadmap into the linked goal through the running host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-gsd-e2e-")), repo = join(dir, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { windowsHide: true });
  const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1", OMB_TEST_GSD_BRIDGE: "1" });
  let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
  try {
    await git("init"); writeFileSync(join(repo, "README.md"), "fixture\n"); await git("add", "README.md");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "init");
    const state = join(fixture.info.dataDir, "gsd-integration"), env = { ...process.env, OMB_GSD_STATE_DIR: state, OMB_TEST_GSD_BRIDGE: "1", OMB_TEST_GSD_BASE: fixture.info.url };
    const prepared = JSON.parse((await exec(process.execPath, [join(process.cwd(), "scripts", "gsd-bridge.mjs"), "prepare", "--repository", repo, "--task", "fixture-1"], { env, timeout: 120_000, windowsHide: true })).stdout);
    const command = ["--experimental-strip-types", join(process.cwd(), "scripts", "gsd-create-goal.ts"), "--task", "fixture-1", "--title", "Fixture goal", "--request", "Build fixture"];
    const created = JSON.parse((await exec(process.execPath, command, { env, timeout: 30_000, windowsHide: true })).stdout);
    const retried = JSON.parse((await exec(process.execPath, command, { env, timeout: 30_000, windowsHide: true })).stdout);
    expect(retried.goalId).toBe(created.goalId);
    const api = fixtureApi(fixture.info.url);
    const pairing = await api("POST", "/api/auth/pairing", { label: "isolated GSD test", scopes: ["admin", "client"] });
    const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated GSD test" });
    const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
    mkdirSync(join(prepared.worktree, ".planning"));
    writeFileSync(join(prepared.worktree, ".planning", "ROADMAP.md"), "# Roadmap\n\n### Phase 1: Foundation\n**Goal**: Build base\n");
    await expect.poll(async () => (await owner("GET", `/api/persistent-work/goals/${created.goalId}`)).gsd?.snapshot?.phase_count, { timeout: 45_000, interval: 1000 }).toBe(1);
    const goal = await owner("GET", `/api/persistent-work/goals/${created.goalId}`);
    expect(goal.gsd.snapshot.phases[0]).toMatchObject({ number: "1", name: "Foundation" });
    expect(goal.status).toBe("planning");
    expect((await owner("GET", "/api/persistent-work/overview")).items).toEqual(expect.arrayContaining([expect.objectContaining({ goalId: created.goalId, status: "gsd" })]));
    preview = await mountPreview(fixture, { entry: "/src/testing/gsd-progress.tsx", route: "/__gsd-progress.html", title: "GSD fixture",
      proxyHeaders: { authorization: `Bearer ${session.token}` }, logLevel: "silent" });
    const chrome = process.env.OMB_TEST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const rendered = await exec(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-extensions",
      `--user-data-dir=${join(fixture.info.dataDir, "chrome-gsd")}`, "--virtual-time-budget=10000", "--dump-dom", preview.previewUrl], { timeout: 60_000, maxBuffer: 4_000_000, windowsHide: true });
    expect(rendered.stdout).toContain("Fixture goal"); expect(rendered.stdout).toContain("Foundation"); expect(rendered.stdout).toContain("阶段进度");
  } finally { await preview?.close(); await fixture.close(); await removeTempDir(dir); }
}, 180_000);
