import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

const identifier = z.string().min(1).max(200);
const partsSchema = z.tuple([identifier, identifier]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export function goalWorkspaceRef(workstreamId: string, taskId: string): string {
  const parts = partsSchema.parse([workstreamId, taskId]);
  return `goal-workspace:${Buffer.from(JSON.stringify(parts)).toString("base64url")}`;
}

export function parseGoalWorkspaceRef(reference: string): { workstreamId: string; taskId: string } | undefined {
  if (!reference.startsWith("goal-workspace:") || reference.length > 1200) return undefined;
  try {
    const encoded = reference.slice("goal-workspace:".length);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return undefined;
    const [workstreamId, taskId] = partsSchema.parse(JSON.parse(bytes.toString("utf8")));
    return { workstreamId, taskId };
  } catch { return undefined; }
}

function ownedDirectory(path: string, parent: string): string {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("goal workspace path is not an owned directory");
  const actual = realpathSync(path);
  const rel = relative(parent, actual);
  if (!samePath(actual, path) || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("goal workspace escapes its parent");
  return actual;
}

export function createGoalWorkspaces(dataDir: string) {
  if (!isAbsolute(dataDir)) throw new Error("goal workspaces require an absolute data directory");
  const base = realpathSync(dataDir);
  return {
    allows(reference: string, workstreamId: string, taskId?: string): boolean {
      const parsed = parseGoalWorkspaceRef(reference);
      return !!parsed && parsed.workstreamId === workstreamId && (taskId === undefined || parsed.taskId === taskId);
    },
    ensure(reference: string, workstreamId: string, taskId: string): string {
      const parsed = parseGoalWorkspaceRef(reference);
      if (!parsed || parsed.workstreamId !== workstreamId || parsed.taskId !== taskId) throw new Error("workspace does not belong to this task");
      const root = ownedDirectory(join(base, "persistent-workspaces"), base);
      const scope = ownedDirectory(join(root, digest(workstreamId)), root);
      return ownedDirectory(join(scope, digest(taskId)), scope);
    },
    existing(reference: string, workstreamId: string, taskId: string): readonly string[] {
      const parsed = parseGoalWorkspaceRef(reference);
      if (!parsed || parsed.workstreamId !== workstreamId || parsed.taskId !== taskId) return [];
      try {
        const root = join(base, "persistent-workspaces"), scope = join(root, digest(workstreamId)), task = join(scope, digest(taskId));
        for (const dir of [root, scope, task]) if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return [];
        const realRoot = realpathSync(root), realScope = realpathSync(scope), realTask = realpathSync(task);
        const within = (parent: string, child: string) => { const rel = relative(parent, child); return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
        return samePath(root, realRoot) && samePath(scope, realScope) && samePath(task, realTask) &&
          within(base, realRoot) && within(realRoot, realScope) && within(realScope, realTask) ? [realTask] : [];
      } catch { return []; }
    },
  };
}
