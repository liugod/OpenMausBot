import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { verificationServerArgs, verificationServerEnvironment } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";
import { needsTrialAssistant } from "./testing/trial-bootstrap.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = join(root, ".persistent-work-trial"), uiPort = 19753;
const serverPort = await freePortBlock([0, 1]);
const executable = process.env.OMB_TRIAL_CODEX_CLI || join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const auth = process.env.OMB_TRIAL_CODEX_AUTH || join(homedir(), ".codex", "auth.json");
const model = process.env.OMB_TRIAL_MODEL || "gpt-6.1-terra";
if (!existsSync(executable) || !existsSync(auth)) throw new Error("Codex 可执行文件或登录状态不可用；请先完成本机 Codex 登录。");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(join(dataDir, "tmp"), { recursive: true, mode: 0o700 });
mkdirSync(join(dataDir, ".codex"), { recursive: true, mode: 0o700 });
const authCopy = join(dataDir, ".codex", "auth.json");
if (!existsSync(authCopy)) { copyFileSync(auth, authCopy); try { chmodSync(authCopy, 0o600); } catch {} }
const config = join(dataDir, "config.json");
if (!existsSync(config)) writeFileSync(config, JSON.stringify({ features: { smartSetupChoices: false }, instances: { codex: { driver: "codex", displayName: "Codex", config: { cli: executable } } } }, null, 2));
const env = verificationServerEnvironment({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1", OMB_VERIFY_ALLOW_PROXY: "1", OMB_DEV_TRUST_LOCAL_BROWSER: "0" }, dataDir, serverPort);
const log = openSync(join(dataDir, "server.log"), "a", 0o600);
const child = spawn(process.execPath, verificationServerArgs(env), { cwd: root, env, stdio: ["ignore", log, log], windowsHide: true });
closeSync(log);
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const base = `http://127.0.0.1:${serverPort}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("试用服务启动失败，请查看试用目录中的 server.log。");
    try { const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok && (await response.json() as {app?:string}).app === "openmausbot") break; } catch {}
    if (Date.now() > deadline) throw new Error("试用服务启动超时。");
    await delay(250);
  }
  const api = fixtureApi(base);
  const pairing = await api("POST", "/api/auth/pairing", { label: "本机试用", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "本机试用" });
  const owner = fixtureApi(base, { headers: { authorization: `Bearer ${session.token}` } });
  const list = await owner("GET", "/api/bots");
  if (needsTrialAssistant(list.bots)) {
    await owner("POST", "/api/bots", { name: "目标助手", description: "执行用户交办的任务并审查成果。", modelSelection: { instanceId: "codex", model } });
  }
  preview = await mountPreview({ info: { url: base } }, { entry: "/scripts/testing/persistent-work-trial.tsx", route: "/", title: "OpenMaus 本机试用", port: uiPort,
    proxyHeaders: { authorization: `Bearer ${session.token}` }, localOriginOnly: true, logLevel: "silent" });
  console.log(`OpenMaus 试用地址：http://127.0.0.1:${uiPort}/`);
  await Promise.race([parkUntilSignal(), new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  })]);
} finally { await preview?.close(); await waitForExit(child, { signal: "SIGTERM" }); }
