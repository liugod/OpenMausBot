import { parentPort, workerData } from "node:worker_threads";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import formats from "ajv-formats";

function check() {
  let data;
  try { data = JSON.parse(workerData.text); } catch { return "fail"; }
  try {
    const dialect = workerData.schema.$schema;
    if (dialect !== undefined && dialect !== "http://json-schema.org/draft-07/schema#" && dialect !== "https://json-schema.org/draft/2020-12/schema") return "unknown";
    const options = { strict: true, strictRequired: false, strictTypes: false, strictTuples: false, allErrors: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true, logger: false };
    const compiler = dialect === "https://json-schema.org/draft/2020-12/schema" ? new Ajv2020(options) : new Ajv(options);
    formats(compiler);
    return compiler.compile(workerData.schema)(data) ? "pass" : "fail";
  } catch { return "unknown"; }
}

parentPort.postMessage(check());
