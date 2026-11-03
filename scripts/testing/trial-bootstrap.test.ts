import { expect, it } from "vitest";
import { needsTrialAssistant } from "./trial-bootstrap";

it("does not recreate a trial assistant after the existing one was renamed", () => {
  expect(needsTrialAssistant([{ defaultBot: {} }, {}])).toBe(false);
  expect(needsTrialAssistant([{ defaultBot: {} }])).toBe(true);
});
