import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer({ ...process.env, OMB_PERSISTENT_WORK_PREVIEW: "1" });
try {
  const api = fixtureApi(fixture.info.url);
  const denied = await fetch(`${fixture.info.url}/api/persistent-work/scopes`);
  if (denied.status !== 403) throw new Error(`unpaired scope access returned ${denied.status}`);
  const pairing = await api("POST", "/api/auth/pairing", { label: "isolated persistent work test", scopes: ["admin", "client"] });
  const session = await api("POST", "/api/auth/pair", { code: pairing.code, label: "isolated test" });
  const owner = fixtureApi(fixture.info.url, { headers: { authorization: `Bearer ${session.token}` } });
  const area = await owner("POST", "/api/persistent-work/areas", { name: "Test research" });
  const stream = await owner("POST", "/api/persistent-work/workstreams", { areaId: area.id, name: "Test brief", kind: "ongoing" });
  const scopes = await owner("GET", "/api/persistent-work/scopes");
  const overview = await owner("GET", `/api/persistent-work/overview?areaId=${encodeURIComponent(area.id)}`);
  if (!scopes.areas.some((item: { id: string }) => item.id === area.id) ||
    !scopes.workstreams.some((item: { id: string }) => item.id === stream.id) || !Array.isArray(overview.items)) {
    throw new Error("created scopes were not returned");
  }
  console.log(JSON.stringify({ ok: true, unpairedStatus: denied.status, areas: scopes.areas.length, workstreams: scopes.workstreams.length }));
} finally { await fixture.close(); }
