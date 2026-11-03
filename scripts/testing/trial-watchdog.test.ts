import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup";

it.skipIf(process.platform !== "win32")("restarts a stopped isolated service but does not start a healthy one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-watchdog-test-"));
  const marker = join(dir, "started.txt"), starter = join(dir, "starter.ps1"), log = join(dir, "watchdog.log");
  const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ app: "openmausbot" })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  writeFileSync(starter, `[System.IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','started')`);
  const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "scripts", "watch-persistent-work-trial.ps1"),
      "-HealthUrl", `${base}/api/health`, "-TrialHomeUrl", `${base}/`, "-StarterPath", starter, "-MutexName", `Local\\omb-fixture-${process.pid}`,
      "-PollSeconds", "1", "-LogPath", log], { stdio: "ignore", windowsHide: true });
  try {
    await delay(3000);
    expect(existsSync(marker)).toBe(false);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await expect.poll(() => existsSync(marker), { timeout: 10_000 }).toBe(true);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await waitForExit(child, { signal: "SIGTERM" });
    for (const file of [marker, starter, log]) if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  }
}, 25_000);
