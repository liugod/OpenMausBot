import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { openExecutionBudgetStore } from "./execution-budget.ts";

describe("goal execution budget", () => {
  it("persists reservations and never sells the same execution or budget slot twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-budget-"));
    try {
      const path = join(dir, "goals.db");
      const first = openExecutionBudgetStore(path);
      first.create("goal", 2);
      first.create("other", 1);
      first.bindRoot("goal", "root");
      first.bindRoot("goal", "root");
      expect(() => first.bindRoot("other", "root")).toThrow(/another goal/);
      expect(first.reserve("goal", "root", 1)).toBe("reserved");
      first.close();
      const a = openExecutionBudgetStore(path);
      const b = openExecutionBudgetStore(path);
      try {
        expect(a.admit("root", "root", 1)).toBe(true);
        expect(a.admit("unknown", "x", 1)).toBe(false);
        expect(a.reserve("goal", "root", 1)).toBe("duplicate");
        expect(() => b.reserve("other", "root", 1)).toThrow(/another goal/);
        expect(b.reserve("goal", "child", 1)).toBe("reserved");
        expect(a.admit("root", "root", 2)).toBe(false);
        expect(a.usage("goal")).toEqual({ limit: 2, reserved: 2 });
        expect(b.reserve("other", "other-root", 1)).toBe("reserved");
        expect(() => a.reserve("missing", "x", 1)).toThrow(/not found/);
      } finally { b.close(); a.close(); }
    } finally { await removeTempDir(dir); }
  });
});
