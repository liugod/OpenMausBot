const text = { type: "string", minLength: 1 };
const version = { type: "integer", minimum: 0 };
const claim = { type: "object", additionalProperties: false, properties: { criterionId: text, verdict: { type: "string", enum: ["met", "not_met", "unknown"] }, note: text },
  required: ["criterionId", "verdict", "note"] };
const criterion = { type: "object", properties: { id: text, description: text, required: { type: "boolean" },
  kind: { type: "string", enum: ["artifact_exists", "json_schema", "command_exit", "lead_review"] }, config: { type: "object" } },
  required: ["id", "description", "required", "kind", "config"] };
const task = { type: "object", properties: { id: text, title: text, brief: text, assigneeBotId: text, required: { type: "boolean" }, workspaceRef: text,
  criteria: { type: "array", minItems: 1, items: criterion }, dependsOn: { type: "array", items: text } },
  required: ["id", "title", "brief", "assigneeBotId", "required", "workspaceRef", "criteria", "dependsOn"] };

export const GOAL_TOOL_ROLES: Record<string, readonly string[]> = {
  goal_context: ["plan", "work", "review"], goal_workspace_for_task: ["plan"], submit_goal_plan: ["plan"], register_goal_artifact: ["work"], submit_goal_task_result: ["work"],
  save_goal_checkpoint: ["work"], list_goal_inputs: ["work"], read_goal_input: ["work"], read_goal_review_artifact: ["review"], submit_goal_review: ["review"],
};

export const GOAL_TOOL_DEFINITIONS = [
  { name: "goal_context", description: "Read the current authorized work item, requirements, versions and assigned role. Never supply an owner or goal ID.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "goal_workspace_for_task", description: "Get an authorized isolated workspace reference for a proposed task in the current workstream.",
    inputSchema: { type: "object", additionalProperties: false, properties: { taskId: text }, required: ["taskId"] } },
  { name: "submit_goal_plan", description: "Submit the structured plan for this authorized planning run. The host validates assignees, workspaces, dependencies and versions.",
    inputSchema: { type: "object", additionalProperties: false, properties: { commandId: text, expectedVersion: version, requirementRevision: version,
      reason: text, tasks: { type: "array", minItems: 1, maxItems: 200, items: task } }, required: ["commandId", "expectedVersion", "requirementRevision", "reason", "tasks"] } },
  { name: "register_goal_artifact", description: "Register an actual file from this task's authorized workspace. Returns its immutable artifact ID and version.",
    inputSchema: { type: "object", additionalProperties: false, properties: { commandId: text, expectedVersion: version, logicalName: text, reference: text },
      required: ["commandId", "expectedVersion", "logicalName", "reference"] } },
  { name: "submit_goal_task_result", description: "Submit the current task's actual artifact IDs and one evidence-backed claim per criterion. This is not itself acceptance.",
    inputSchema: { type: "object", additionalProperties: false, properties: { commandId: text, expectedVersion: version, requirementRevision: version,
      planRevision: version, artifactIds: { type: "array", items: text }, claims: { type: "array", items: claim }, knownIssues: { type: "array", items: { type: "string" } } },
      required: ["commandId", "expectedVersion", "requirementRevision", "planRevision", "artifactIds", "claims", "knownIssues"] } },
  { name: "save_goal_checkpoint", description: "Save a bounded continuation note, remaining work, blockers and next step. This note is unverified and never counts as acceptance. Read current context first.",
    inputSchema: { type: "object", additionalProperties: false, properties: { commandId: text, expectedVersion: version, summary: { ...text, maxLength: 4000 },
      remaining: { type: "array", maxItems: 30, items: { ...text, maxLength: 1000 } }, blockers: { type: "array", maxItems: 20, items: { ...text, maxLength: 1000 } },
      nextStep: { ...text, maxLength: 2000 } }, required: ["commandId", "expectedVersion", "summary", "remaining", "blockers", "nextStep"] } },
  { name: "list_goal_inputs", description: "List the exact approved predecessor artifact versions available to this task.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "read_goal_input", description: "Read an authorized predecessor snapshot in base64 chunks of at most 65536 bytes.",
    inputSchema: { type: "object", additionalProperties: false, properties: { artifactId: text, offset: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, maximum: 65536 } }, required: ["artifactId", "offset", "length"] } },
  { name: "read_goal_review_artifact", description: "Read a chunk of an authorized current review artifact. The host verifies its registered hash before returning data.",
    inputSchema: { type: "object", additionalProperties: false, properties: { artifactId: text, offset: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, maximum: 65536 } }, required: ["artifactId", "offset", "length"] } },
  { name: "submit_goal_review", description: "Submit one pass, fail or unknown verdict with evidence for each required criterion in this assigned review.",
    inputSchema: { type: "object", additionalProperties: false, properties: { commandId: text, expectedVersion: version,
      verdicts: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { criterionId: text,
        verdict: { type: "string", enum: ["pass", "fail", "unknown"] }, reason: text }, required: ["criterionId", "verdict", "reason"] } } },
      required: ["commandId", "expectedVersion", "verdicts"] } },
];
