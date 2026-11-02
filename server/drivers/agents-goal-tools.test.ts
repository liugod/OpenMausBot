import { describe, expect, it } from "vitest";
import { agentsToolList } from "./agents-mcp.ts";
import { GOAL_TOOL_ROLES } from "./agents-goal-tools.ts";

const goalNames = (env: NodeJS.ProcessEnv) => agentsToolList(env).available.map(tool => tool.name).filter(name => Object.hasOwn(GOAL_TOOL_ROLES, name)).sort();

describe("goal tools in the native agents catalog", () => {
  it("does not advertise goal capabilities outside an assigned goal run", () => {
    expect(goalNames({})).toEqual([]);
    expect(goalNames({ OMB_GOAL_ROLE: "untrusted" })).toEqual([]);
  });
  it("only exposes the tools for the assigned role", () => {
    expect(goalNames({ OMB_GOAL_ROLE: "plan" })).toEqual(["goal_context", "goal_workspace_for_task", "submit_goal_plan"]);
    expect(goalNames({ OMB_GOAL_ROLE: "review" })).toEqual(["goal_context", "read_goal_review_artifact", "submit_goal_review"]);
    expect(goalNames({ OMB_GOAL_ROLE: "work" })).toEqual(["goal_context", "list_goal_inputs", "read_goal_input", "register_goal_artifact", "submit_goal_task_result"]);
  });
});
