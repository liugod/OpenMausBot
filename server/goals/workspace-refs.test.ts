import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { createGoalWorkspaces, goalWorkspaceRef, parseGoalWorkspaceRef } from "./workspace-refs.ts";

describe("isolated goal workspaces", () => {
  it("uses stable per-task directories and refuses another scope or a forged reference", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-workspace-ref-"));
    try {
      const workspaces = createGoalWorkspaces(dir);
      const one = goalWorkspaceRef("area-one", "task-one");
      const two = goalWorkspaceRef("area-two", "task-one");
      expect(parseGoalWorkspaceRef(one)).toEqual({ workstreamId: "area-one", taskId: "task-one" });
      expect(parseGoalWorkspaceRef(`${one}=`)).toBeUndefined();
      expect(workspaces.allows(one, "area-two")).toBe(false);
      expect(workspaces.existing(one, "area-one", "task-one")).toEqual([]);
      const path = workspaces.ensure(one, "area-one", "task-one");
      expect(workspaces.existing(one, "area-one", "task-one")).toEqual([path]);
      expect(workspaces.ensure(two, "area-two", "task-one")).not.toBe(path);
      expect(() => workspaces.ensure(one, "area-two", "task-one")).toThrow(/does not belong/);
      expect(() => workspaces.ensure(one, "area-one", "other-task")).toThrow(/does not belong/);
    } finally { await removeTempDir(dir); }
  });

  it("rejects a workspace root that is a directory link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-workspace-link-"));
    try {
      const outside = join(dir, "outside"); mkdirSync(outside);
      symlinkSync(outside, join(dir, "persistent-workspaces"), process.platform === "win32" ? "junction" : "dir");
      const workspaces = createGoalWorkspaces(dir);
      const reference = goalWorkspaceRef("scope", "task");
      expect(() => workspaces.ensure(reference, "scope", "task")).toThrow(/not an owned directory/);
      expect(workspaces.existing(reference, "scope", "task")).toEqual([]);
    } finally { await removeTempDir(dir); }
  });
});
