import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1" });
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { label: "isolated UI test", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated UI test" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  const area = await owner("POST", "/api/persistent-work/areas", { name: "业务研究" });
  await owner("POST", "/api/persistent-work/workstreams", { areaId: area.id, name: "每周市场简报", kind: "ongoing" });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/persistent-work-preview.tsx", route: "/__work.html",
    title: "Isolated work preview", proxyHeaders: { authorization: `Bearer ${session.token}` }, logLevel: "silent" });
  console.log(JSON.stringify({ url: `${preview.previewUrl}?persistent-work-preview=1` }));
  await new Promise<void>(resolve => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); });
} finally { await preview?.close(); await fixture.close(); }
