import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";
const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1", OMB_PERSISTENT_WORK_RUNTIME_TEST: "1" }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { label: "isolated trial UI", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated trial UI" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  await owner("POST", "/api/bots", { name: "目标助手", modelSelection: { instanceId: "codex", model: "fixture-model" } });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/persistent-work-trial.tsx", route: "/", title: "isolated trial", proxyHeaders: { authorization: `Bearer ${session.token}` }, logLevel: "silent" });
  const chrome = process.env.OMB_TEST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const { stdout } = await promisify(execFile)(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-extensions", `--user-data-dir=${join(fixture.info.dataDir, "chrome-test")}`, "--virtual-time-budget=6000", "--dump-dom", preview.previewUrl], { timeout: 45_000, maxBuffer: 2_000_000 });
  for (const text of ["把任务交给目标助手", "第一次使用", "工作分类", "交代要做什么", "提交并开始", "目标助手"]) if (!stdout.includes(text)) throw new Error(`trial UI missing ${text}`);
  console.log(JSON.stringify({ ok: true, page: "trial UI", isolated: true }));
} finally { await preview?.close(); await fixture.close(); }
