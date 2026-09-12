import { describe, it, expect } from "vitest";
import {
  createModel,
  providerInfo,
  assertProvider,
} from "../server/providers.js";
describe("per-agent provider configuration", () => {
  it("reports availability without returning credentials", () => {
    const info = providerInfo({
      OPENAI_API_KEY: "unit-test-only",
      GEMINI_API_KEY: "unit-test-only",
    });
    expect(info.map((i) => i.available)).toEqual([true, false, true]);
    expect(JSON.stringify(info)).not.toContain("unit-test-only");
  });
  it("creates independent OpenAI, OpenRouter and Gemini models without making network calls", () => {
    const env = {
      OPENAI_API_KEY: "unit-test-only",
      OPENROUTER_API_KEY: "unit-test-only",
      GEMINI_API_KEY: "unit-test-only",
    };
    const a = createModel({ provider: "openai", model: "gpt-4.1" }, env);
    const b = createModel(
      { provider: "openrouter", model: "openai/gpt-4.1" },
      env,
    );
    const c = createModel(
      { provider: "gemini", model: "gemini-2.5-flash" },
      env,
    );
    expect(a.modelId).toBe("gpt-4.1");
    expect(b.modelId).toBe("openai/gpt-4.1");
    expect(c.provider).toContain("google");
    expect(a).not.toBe(b);
  });
  it("rejects a missing key before any browser task runs", () => {
    expect(() =>
      assertProvider({ provider: "openrouter", model: "test" }, {}),
    ).toThrow("OPENROUTER_API_KEY");
  });
});
