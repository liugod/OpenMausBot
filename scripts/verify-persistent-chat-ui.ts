import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";
const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" });
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { label: "isolated chat test", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated chat test" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  const bot = (await owner("POST", "/api/bots", { name: "Isolated Chat Bot" })).bot;
  await owner("POST", "/api/persistent-work/chat-tasks", { commandId: "isolated-chat-test", botId: bot.id, threadId: bot.threadId,
    request: "Synthetic research task", executionLimit: 8 });
  preview = await mountPreview(fixture, { entry: "/src/testing/persistent-chat.tsx", route: "/__persistent-chat.html", title: "Isolated chat test",
    proxyHeaders: { authorization: `Bearer ${session.token}` }, logLevel: "silent" });
  if (process.env.OMB_VERIFY_BROWSER_MANUAL === "1") {
    console.log(`PREVIEW ${preview.previewUrl}?persistent-work=1`);
    await new Promise<void>(resolve => { setTimeout(resolve, 180_000); process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); });
  } else {
  const chrome = process.env.OMB_TEST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const { stdout } = await promisify(execFile)(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-extensions",
    `--user-data-dir=${join(fixture.info.dataDir, "chrome-chat")}`, "--virtual-time-budget=10000", "--dump-dom", `${preview.previewUrl}?persistent-work=1`], { timeout: 60_000, maxBuffer: 4_000_000 });
  for (const text of ["Synthetic research task", "该助手的任务", "交办为任务"]) if (!stdout.includes(text)) throw new Error(`chat UI missing ${text}`);
  console.log(JSON.stringify({ ok: true, originalChat: true, taskVisible: true, isolated: true }));
  }
} finally { await preview?.close(); await fixture.close(); }
