import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { openGoalStore } from "./goal-store.ts";

const exec = promisify(execFile);
const phase = z.object({ number: z.string().min(1).max(100), name: z.string().max(500), goal: z.string().max(4000).nullable().optional(),
  disk_status: z.string().max(100), roadmap_complete: z.boolean(), plan_count: z.number().int().nonnegative(), summary_count: z.number().int().nonnegative() });
const roadmap = z.object({ phases: z.array(phase).max(500), scope: z.string().max(100), progress_percent: z.number().min(0).max(100).nullable(),
  current_phase: z.string().nullable(), next_phase: z.string().nullable(), completed_phases: z.number().int().nonnegative(), phase_count: z.number().int().nonnegative() });

export async function syncGsdGoals(dataDir: string, goals: ReturnType<typeof openGoalStore>) {
  for (const link of goals.gsdLinks()) {
    try {
      const hash = createHash("sha256").update(link.taskId).digest("hex");
      const root = join(dataDir, "gsd-integration");
      const record = JSON.parse(readFileSync(join(root, "runs", `${hash}.json`), "utf8")) as { taskId?: string; state?: string; worktree?: string };
      const workspaceRoot = realpathSync(join(root, "worktrees")), expected = realpathSync(join(workspaceRoot, hash));
      const relativeTree = relative(workspaceRoot, expected);
      if (!relativeTree || relativeTree.startsWith("..") || isAbsolute(relativeTree) || relativeTree !== hash || record.taskId !== link.taskId || record.state !== "ready" || !record.worktree || realpathSync(record.worktree) !== expected) throw new Error("GSD workspace identity is unavailable or mismatched");
      const packageRoot = resolve(process.cwd(), "..", "intake", "gsd-core-package-v1.21.0", "package");
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name !== "@opengsd/gsd-core" || pkg.version !== "1.21.0") throw new Error("GSD package version mismatch");
      const tool = join(packageRoot, "gsd-core", "bin", "gsd-tools.cjs");
      if (!existsSync(join(expected, ".planning", "ROADMAP.md"))) {
        if (link.snapshot?.planning) throw new Error("GSD roadmap is missing; last snapshot retained");
        goals.saveGsdSnapshot(link.taskId, { planning: false, phases: [] });
        continue;
      }
      const { stdout } = await exec(process.execPath, [tool, "roadmap", "analyze"], { cwd: expected, timeout: 30_000, maxBuffer: 1_000_000, windowsHide: true,
        env: { ...process.env, GSD_HOME: join(root, "gsd-home") } });
      const result = roadmap.parse(JSON.parse(stdout));
      goals.saveGsdSnapshot(link.taskId, { planning: true, ...result });
    } catch (error) {
      goals.failGsdSnapshot(link.taskId, error instanceof Error ? error.message : "GSD sync failed");
    }
  }
}
