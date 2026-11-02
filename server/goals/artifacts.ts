import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";

import { openMessageFile } from "../message-file.ts";

export interface InspectedArtifact {
  reference: string;
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactRequirements {
  minBytes?: number;
  maxBytes?: number;
  mediaTypes?: string[];
  extensions?: string[];
}

async function readArtifact(reference: string, authorizedRoots: readonly string[], maxBytes?: number): Promise<{ artifact: InspectedArtifact; content: Buffer }> {
  const file = await openMessageFile(reference, authorizedRoots);
  try {
    if (maxBytes !== undefined && file.bytes > maxBytes) throw new Error("artifact exceeds checker limit");
    const before = await file.handle.stat();
    const content = await file.handle.readFile();
    const after = await file.handle.stat();
    if (content.length !== file.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("artifact changed while being inspected");
    }
    return { artifact: { reference, name: file.name, mediaType: file.mime, bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex") }, content };
  } finally { await file.handle.close(); }
}

export async function inspectArtifact(reference: string, authorizedRoots: readonly string[]): Promise<InspectedArtifact> {
  return (await readArtifact(reference, authorizedRoots)).artifact;
}

export async function captureArtifact(expected: Pick<InspectedArtifact, "reference" | "sha256" | "bytes">,
  authorizedRoots: readonly string[], maxBytes?: number): Promise<Buffer> {
  const { artifact, content } = await readArtifact(expected.reference, authorizedRoots, maxBytes);
  if (artifact.sha256 !== expected.sha256 || artifact.bytes !== expected.bytes) throw new Error("artifact changed before snapshot");
  return content;
}

export async function checkArtifact(expected: Pick<InspectedArtifact, "reference" | "sha256" | "bytes">, authorizedRoots: readonly string[],
  requirements: ArtifactRequirements = {}): Promise<"pass" | "fail" | "unknown"> {
  if ((requirements.minBytes !== undefined && (!Number.isSafeInteger(requirements.minBytes) || requirements.minBytes < 0)) ||
    (requirements.maxBytes !== undefined && (!Number.isSafeInteger(requirements.maxBytes) || requirements.maxBytes < 0)) ||
    (requirements.minBytes !== undefined && requirements.maxBytes !== undefined && requirements.minBytes > requirements.maxBytes)) return "unknown";
  try {
    const current = await inspectArtifact(expected.reference, authorizedRoots);
    if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes ||
      (requirements.minBytes !== undefined && current.bytes < requirements.minBytes) ||
      (requirements.maxBytes !== undefined && current.bytes > requirements.maxBytes) ||
      (requirements.mediaTypes && !requirements.mediaTypes.some(type => type.toLowerCase() === current.mediaType.split(";", 1)[0]!.toLowerCase())) ||
      (requirements.extensions && !requirements.extensions.some(ext => ext.toLowerCase() === extname(current.name).toLowerCase()))) return "fail";
    return "pass";
  } catch {
    return "unknown";
  }
}

const sourceWorker = new URL("./json-check.worker.mjs", import.meta.url);
const bundledWorker = new URL("./goals/json-check.worker.cjs", import.meta.url);

export async function checkJsonSchema(expected: Pick<InspectedArtifact, "reference" | "sha256" | "bytes">, schema: Record<string, unknown>,
  authorizedRoots: readonly string[], timeoutMs = 2000): Promise<"pass" | "fail" | "unknown"> {
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 || JSON.stringify(schema).length > 64_000) return "unknown";
    const { artifact, content } = await readArtifact(expected.reference, authorizedRoots, 1024 * 1024);
    if (artifact.sha256 !== expected.sha256 || artifact.bytes !== expected.bytes) return "fail";
    return await new Promise(resolve => {
      const worker = new Worker(existsSync(sourceWorker) ? sourceWorker : bundledWorker, { workerData: { schema, text: content.toString("utf8") },
        resourceLimits: { maxOldGenerationSizeMb: 64 } });
      let settled = false;
      const finish = (result: "pass" | "fail" | "unknown") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(result);
      };
      const timer = setTimeout(() => finish("unknown"), timeoutMs);
      worker.once("message", value => finish(value === "pass" || value === "fail" ? value : "unknown"));
      worker.once("error", () => finish("unknown"));
      worker.once("exit", () => finish("unknown"));
    });
  } catch { return "unknown"; }
}
