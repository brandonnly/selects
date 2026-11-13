import { describe, expect, test } from "bun:test";
import { outcomeText, parseEvents, testResultText } from "./notifications";

const saved = { events: { posted: true, failed: true, token: true, pool: true }, poolThreshold: 10 };

describe("parseEvents", () => {
  test("takes the switches and a whole-number threshold", () => {
    const draft = { events: { ...saved.events, posted: false }, poolThreshold: " 25 " };

    expect(parseEvents(draft, saved)).toEqual({
      settings: { events: { ...saved.events, posted: false }, poolThreshold: 25 },
      error: undefined,
    });
  });

  test("keeps the saved threshold while the one typed is not a whole number from 1 to 10,000", () => {
    for (const poolThreshold of ["0", "", "2.5", "10001"]) {
      expect(parseEvents({ events: saved.events, poolThreshold }, saved)).toEqual({
        settings: saved,
        error: "A whole number from 1 to 10,000.",
      });
    }
  });
});

describe("what Settings says", () => {
  test("about a notice", () => {
    expect(outcomeText("sent")).toBe("Sent");
    expect(outcomeText("failed")).toBe("Not sent to every channel");
    expect(outcomeText("would-send")).toBe("Would have been sent (fake mode)");
    expect(outcomeText("no-channel")).toBe("No channel set");
  });

  test("about a test", () => {
    expect(testResultText({ status: "sent" })).toBe("Sent. Check that it arrived.");
    expect(testResultText({ status: "failed", reason: "The server answered 403." })).toBe(
      "Couldn't send: The server answered 403.",
    );
    expect(testResultText({ status: "would-send", message: "Fake mode: nothing was sent." })).toBe(
      "Fake mode: nothing was sent.",
    );
  });
});
