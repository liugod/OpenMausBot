import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = resolve(process.env.OMB_GSD_STATE_DIR || join(root, ".persistent-work-trial", "gsd-integration"));
const packageRoot = resolve(process.env.OMB_GSD_PACKAGE_ROOT || join(root, "..", "intake", "gsd-core-package-v1.21.0", "package"));
const configFile = join(root, "..", "gsd-local", "openmaus-bridge-config.json");
const version = "1.21.0";
const taskPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
const gitExecutable = process.env.OMB_GSD_GIT || config.gitExecutable || "git";
if (gitExecutable !== "git" && (!isAbsolute(gitExecutable) || !existsSync(gitExecutable))) throw new Error("Configured Git executable is unavailable");
const gsdEnv = { ...process.env, GSD_HOME: join(stateRoot, "gsd-home"), ...(isAbsolute(gitExecutable) ? { PATH: [dirname(gitExecutable), process.env.PATH || ""].join(delimiter) } : {}) };

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4_000_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || (result.stderr || "").slice(-1000) || `exit ${result.status}`}`);
  return result.stdout.trim();
}
function git(repo, ...args) { return run(gitExecutable, ["-C", repo, ...args], repo); }
function metaPath(taskId) { return join(stateRoot, "runs", `${createHash("sha256").update(taskId).digest("hex")}.json`); }
function readMeta(taskId) {
  if (!taskPattern.test(taskId)) throw new Error("task must be 1-80 ASCII letters, numbers, underscores or hyphens");
  const path = metaPath(taskId);
  if (!existsSync(path)) throw new Error("GSD task not found");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.taskId !== taskId) throw new Error("task identity mismatch");
  return value;
}
function writeMeta(meta) { writeFileSync(metaPath(meta.taskId), JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 }); }
function status(taskId) {
  const meta = readMeta(taskId);
  if (meta.state !== "ready") return meta;
  const worktree = realpathSync(meta.worktree);
  const head = git(worktree, "rev-parse", "HEAD");
  const trackedChanges = git(worktree, "status", "--porcelain", "--untracked-files=no");
  const untracked = git(worktree, "ls-files", "--others", "--exclude-standard").split("\n").filter(line => line && !line.startsWith(".codex/"));
  const tools = join(worktree, ".codex", "gsd-core", "bin", "gsd-tools.cjs");
  const progress = JSON.parse(run(process.execPath, [tools, "init", "progress"], worktree, { env: gsdEnv }));
  return { ...meta, head, trackedChanges: Boolean(trackedChanges), untrackedCount: untracked.length, gsd: { planningExists: progress.planning_exists, stateExists: progress.state_exists,
    currentPhase: progress.current_phase, completedCount: progress.completed_count, phaseCount: progress.phase_count, pausedAt: progress.paused_at } };
}
function prepare(repository, taskId) {
  if (!taskPattern.test(taskId)) throw new Error("task must be 1-80 ASCII letters, numbers, underscores or hyphens");
  if (!isAbsolute(repository)) throw new Error("repository must be an absolute path");
  const repo = realpathSync(repository);
  const gitRoot = realpathSync(git(repo, "rev-parse", "--show-toplevel"));
  if (gitRoot !== repo) throw new Error("repository must identify the Git root exactly");
  mkdirSync(join(stateRoot, "runs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, "worktrees"), { recursive: true, mode: 0o700 });
  const file = metaPath(taskId);
  if (existsSync(file)) {
    const previous = readMeta(taskId);
    if (previous.repository !== repo) throw new Error("task ID already belongs to another repository");
    return status(taskId);
  }
  if (git(repo, "status", "--porcelain")) throw new Error("repository has uncommitted changes; select a clean checkout before preparing");
  const baseCommit = git(repo, "rev-parse", "--verify", "HEAD^{commit}");
  if (git(repo, "ls-tree", "--name-only", "HEAD", ".codex")) throw new Error("repository already tracks .codex; install needs separate review");
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "@opengsd/gsd-core" || pkg.version !== version) throw new Error("GSD package version mismatch");
  const hash = createHash("sha256").update(taskId).digest("hex");
  const worktree = join(stateRoot, "worktrees", hash);
  if (existsSync(worktree)) throw new Error("worktree path exists without a task record; inspect before retry");
  const meta = { taskId, repository: repo, worktree, baseCommit, gsdVersion: version, state: "preparing" };
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(meta, null, 2)); } finally { closeSync(fd); }
  try {
    git(repo, "worktree", "add", "--detach", worktree, baseCommit);
    if (existsSync(join(worktree, ".codex"))) throw new Error("worktree contains existing .codex; refusing to overwrite");
    mkdirSync(join(stateRoot, "gsd-home"), { recursive: true, mode: 0o700 });
    run(process.execPath, [join(packageRoot, "bin", "install.js"), "--codex", "--local", "--relative-includes", "--no-legacy-cleanup"], worktree,
      { env: gsdEnv });
    if (readFileSync(join(worktree, ".codex", "gsd-core", "VERSION"), "utf8").trim() !== version) throw new Error("installed GSD version mismatch");
    meta.state = "ready"; writeMeta(meta);
    return status(taskId);
  } catch (error) {
    meta.state = "needs_inspection"; meta.error = error instanceof Error ? error.message : String(error); writeMeta(meta);
    throw error;
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined || Object.hasOwn(options, args[i])) throw new Error("invalid arguments");
    options[args[i]] = args[i + 1];
  }
  if (command === "prepare" && Object.keys(options).length === 2 && options["--repository"] && options["--task"]) console.log(JSON.stringify(prepare(options["--repository"], options["--task"])));
  else if (command === "status" && Object.keys(options).length === 1 && options["--task"]) console.log(JSON.stringify(status(options["--task"])));
  else throw new Error("usage: gsd-bridge.mjs prepare --repository <absolute git root> --task <id> | status --task <id>");
} catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
