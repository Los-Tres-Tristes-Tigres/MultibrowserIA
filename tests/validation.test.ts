import { afterEach, describe, expect, it } from "vitest";
import { publicError, structuredData } from "../server/validation.js";

describe("structured model data", () => {
  it("parses objects and fenced JSON, and keeps malformed output as text", () => {
    expect(structuredData('{"title":"Demo"}')).toEqual({ title: "Demo" });
    expect(structuredData('```json\n{"title":"Demo"}\n```')).toEqual({
      title: "Demo",
    });
    expect(structuredData("[1,2]")).toEqual({ value: [1, 2] });
    expect(structuredData("Meeting on Oct 1")).toEqual({
      text: "Meeting on Oct 1",
    });
    expect(structuredData("  ")).toEqual({});
  });
});

describe("public errors", () => {
  const previous = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  });
  it("redacts the configured key and common credential formats", () => {
    process.env.GEMINI_API_KEY = "configured-unit-test-secret";
    const message = publicError(
      new Error(
        `failed configured-unit-test-secret AIza${"A".repeat(35)} sk-test_ABCDEFGHIJKLMNOPQRSTUV https://x.test/v1?key=abc123&alt=json Bearer abc.def`,
      ),
    );
    expect(message).not.toMatch(
      /configured-unit-test-secret|AIzaA|sk-test|abc123|abc\.def/,
    );
    expect(message).toContain("[redacted]");
  });
});
