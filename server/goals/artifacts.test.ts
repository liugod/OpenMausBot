import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { checkArtifact, checkJsonSchema, inspectArtifact } from "./artifacts.ts";

describe("goal artifact inspection", () => {
  it("hashes real authorized files and rejects missing or outside paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-artifact-"));
    try {
      const workspace = join(dir, "work");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "report.txt"), "first");
      writeFileSync(join(dir, "private.txt"), "outside");
      const first = await inspectArtifact("report.txt", [workspace]);
      expect(first).toMatchObject({ reference: "report.txt", bytes: 5, mediaType: "text/plain; charset=utf-8" });
      await expect(checkArtifact(first, [workspace])).resolves.toBe("pass");
      await expect(checkArtifact(first, [workspace], { minBytes: 6 })).resolves.toBe("fail");
      await expect(checkArtifact(first, [workspace], { maxBytes: 4 })).resolves.toBe("fail");
      await expect(checkArtifact(first, [workspace], { mediaTypes: ["application/json"] })).resolves.toBe("fail");
      await expect(checkArtifact(first, [workspace], { mediaTypes: ["text/plain"], extensions: [".TXT"] })).resolves.toBe("pass");
      await expect(checkArtifact(first, [workspace], { extensions: [".json"] })).resolves.toBe("fail");
      writeFileSync(join(workspace, "report.txt"), "second");
      const second = await inspectArtifact("report.txt", [workspace]);
      expect(second.sha256).not.toBe(first.sha256);
      await expect(checkArtifact(first, [workspace])).resolves.toBe("fail");
      await expect(checkArtifact({ ...first, reference: "missing.txt" }, [workspace])).resolves.toBe("unknown");
      await expect(inspectArtifact("missing.txt", [workspace])).rejects.toMatchObject({ status: 404 });
      await expect(inspectArtifact("../private.txt", [workspace])).rejects.toMatchObject({ status: 403 });
    } finally { await removeTempDir(dir); }
  });

  it("validates the exact registered JSON bytes and treats invalid schemas as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-json-check-"));
    try {
      writeFileSync(join(dir, "report.json"), JSON.stringify({ name: "Ada", count: 2 }));
      const artifact = await inspectArtifact("report.json", [dir]);
      const schema = { type: "object", properties: { name: { type: "string" }, count: { type: "integer", minimum: 1 } },
        required: ["name", "count"], additionalProperties: false };
      await expect(checkJsonSchema(artifact, schema, [dir])).resolves.toBe("pass");
      await expect(checkJsonSchema(artifact, { ...schema, required: ["missing"] }, [dir])).resolves.toBe("fail");
      await expect(checkJsonSchema(artifact, { type: "not-a-json-type" }, [dir])).resolves.toBe("unknown");
      await expect(checkJsonSchema(artifact, { $ref: "https://example.invalid/external.json" }, [dir])).resolves.toBe("unknown");
      writeFileSync(join(dir, "report.json"), "not json");
      await expect(checkJsonSchema(artifact, schema, [dir])).resolves.toBe("fail");
      const invalid = await inspectArtifact("report.json", [dir]);
      await expect(checkJsonSchema(invalid, schema, [dir])).resolves.toBe("fail");
      await expect(checkJsonSchema({ ...invalid, reference: "missing.json" }, schema, [dir])).resolves.toBe("unknown");
    } finally { await removeTempDir(dir); }
  });

  it("runs the bundled checker without a node_modules directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-bundled-check-"));
    try {
      const output = join(dir, "checker.cjs");
      await build({ entryPoints: [fileURLToPath(new URL("./json-check.worker.mjs", import.meta.url))],
        bundle: true, platform: "node", target: "node20", format: "cjs", outfile: output });
      const worker = new Worker(output, { workerData: { text: '{"n":3}', schema: { type: "object", required: ["n"] } } });
      expect(await once(worker, "message")).toEqual(["pass"]);
      await worker.terminate();
    } finally { await removeTempDir(dir); }
  });
});
