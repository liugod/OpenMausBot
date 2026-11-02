import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { acquireSchedulerLock } from "./scheduler-lock.ts";

describe("goal scheduler ownership", () => {
  it("refuses a second writer and allows ownership after the first closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-lock-"));
    try {
      const path = join(dir, "lock.db");
      const first = acquireSchedulerLock(path);
      expect(() => acquireSchedulerLock(path)).toThrow(/cannot acquire/);
      first.close();
      first.close();
      const second = acquireSchedulerLock(path);
      second.close();
      expect(() => acquireSchedulerLock(":memory:")).toThrow(/local file/);
    } finally { await removeTempDir(dir); }
  });

  it("releases the lock when its owning process exits abruptly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-lock-process-"));
    const path = join(dir, "lock.db");
    const moduleUrl = pathToFileURL(join(process.cwd(), "server", "goals", "scheduler-lock.ts")).href;
    const code = `import { acquireSchedulerLock } from ${JSON.stringify(moduleUrl)}; acquireSchedulerLock(process.argv[1]); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        once(child.stdout, "data"),
        exited.then(() => { throw new Error("lock owner exited before acquiring the lock"); }),
      ]);
      expect(() => acquireSchedulerLock(path)).toThrow(/cannot acquire/);
      child.kill();
      await exited;
      const next = acquireSchedulerLock(path);
      next.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      await removeTempDir(dir);
    }
  });
});
