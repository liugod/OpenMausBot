import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

it("prepares an isolated GSD worktree once and refuses dirty or conflicting inputs", () => {
  const tempBase = resolve(tmpdir());
  const base = mkdtempSync(join(tempBase, "omb-gsd-bridge-"));
  const rel = relative(tempBase, resolve(base));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("unsafe fixture path");
  const repo = join(base, "repo"), state = join(base, "state");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const bridge = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "scripts", "gsd-bridge.mjs"), ...args],
    { encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, OMB_GSD_STATE_DIR: state } });
  try {
    git("init");
    writeFileSync(join(repo, "hello.txt"), "baseline\n");
    git("add", "hello.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial");
    const before = git("rev-parse", "HEAD");
    const first = bridge("prepare", "--repository", repo, "--task", "fixture-1");
    expect(first.status, first.stderr).toBe(0);
    const result = JSON.parse(first.stdout);
    expect(result).toMatchObject({ taskId: "fixture-1", baseCommit: before, state: "ready", gsdVersion: "1.21.0" });
    expect(result.gsd.planningExists).toBe(false);
    expect(existsSync(join(result.worktree, ".codex", "skills", "gsd-fast", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".codex"))).toBe(false);
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("baseline\n");
    const retry = bridge("prepare", "--repository", repo, "--task", "fixture-1");
    expect(retry.status, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout).worktree).toBe(result.worktree);
    writeFileSync(join(result.worktree, "new-output.txt"), "result\n");
    const current = bridge("status", "--task", "fixture-1");
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout).untrackedCount).toBe(1);
    writeFileSync(join(repo, "hello.txt"), "uncommitted\n");
    expect(bridge("prepare", "--repository", repo, "--task", "fixture-2").status).not.toBe(0);
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("uncommitted\n");
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 180_000);
