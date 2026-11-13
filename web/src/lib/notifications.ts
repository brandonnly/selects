import type { SentNotice, TestResult } from "@selects/server";
import { wholeNumber } from "./schedule";

export type EventSwitches = { posted: boolean; failed: boolean; token: boolean; pool: boolean };
export type EventSettings = { events: EventSwitches; poolThreshold: number };
export type EventsDraft = { events: EventSwitches; poolThreshold: string };

export const POOL_THRESHOLD = { min: 1, max: 10_000 } as const;

/** The events to save: the threshold as typed while it is valid, and otherwise the one saved. */
export function parseEvents(
  draft: EventsDraft,
  saved: EventSettings,
): { settings: EventSettings; error: string | undefined } {
  const parsed = wholeNumber(draft.poolThreshold, POOL_THRESHOLD);
  return {
    settings: { events: draft.events, poolThreshold: parsed.ok ? parsed.value : saved.poolThreshold },
    error: parsed.ok ? undefined : parsed.problem,
  };
}

export function outcomeText(outcome: SentNotice["outcome"]): string {
  switch (outcome) {
    case "sent":
      return "Sent";
    case "failed":
      return "Not sent to every channel";
    case "would-send":
      return "Would have been sent (fake mode)";
    case "no-channel":
      return "No channel set";
  }
}

export function testResultText(result: Exclude<TestResult, { status: "not-configured" }>): string {
  switch (result.status) {
    case "sent":
      return "Sent. Check that it arrived.";
    case "failed":
      return `Couldn't send: ${result.reason}`;
    case "would-send":
      return result.message;
  }
}
