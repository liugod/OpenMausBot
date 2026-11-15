import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "..", "gsd-local"), file = join(dir, "openmaus-bridge-config.json");
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (!isAbsolute(saved.gitExecutable || "") || !existsSync(saved.gitExecutable)) throw new Error("Existing bridge configuration needs review; it was not changed");
    const check = spawnSync(saved.gitExecutable, ["--version"], { encoding: "utf8", windowsHide: true });
    if (check.status !== 0) throw new Error("Configured Git executable failed; configuration was not changed");
    console.log(JSON.stringify({ ok: true, existing: true, gitExecutable: saved.gitExecutable }));
  } else {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const found = spawnSync(finder, ["git"], { encoding: "utf8", windowsHide: true });
    const gitExecutable = found.stdout?.split(/\r?\n/).find(line => line.trim())?.trim();
    if (found.status !== 0 || !gitExecutable || !isAbsolute(gitExecutable) || !existsSync(gitExecutable)) throw new Error("Could not find an absolute Git executable");
    const check = spawnSync(gitExecutable, ["--version"], { encoding: "utf8", windowsHide: true });
    if (check.status !== 0) throw new Error("Git executable failed its version check");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ gitExecutable }, null, 2), { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ ok: true, existing: false, gitExecutable }));
  }
} catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
