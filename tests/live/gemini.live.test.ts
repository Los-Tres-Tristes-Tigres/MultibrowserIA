/**
 * Opt-in live check: real Gemini calls with GEMINI_API_KEY from .env (`npm run test:live`).
 * It never prints the key and never executes an action; the browser part uses a local test page.
 */
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPlanner,
  providerInfo,
  stepSchema,
} from "../../server/providers.js";
import { BrowserManager } from "../../server/browser.js";
import { WorkspaceStore } from "../../server/store.js";
import { requiresApproval } from "../../server/policy.js";
import { structuredData } from "../../server/validation.js";
import { startFixtures } from "../fixtures.js";

const key = process.env.GEMINI_API_KEY?.trim() ?? "";
const model = process.env.ORBIT_LIVE_GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
});

describe.skipIf(!key)(`live Gemini · ${model}`, () => {
  it("is detected by the backend without exposing the key", () => {
    expect(providerInfo().find((p) => p.id === "gemini")?.available).toBe(true);
    expect(JSON.stringify(providerInfo())).not.toContain(key);
  });

  it("returns one schema-valid planning step with structured handoff data", async () => {
    const step = await createPlanner({ provider: "gemini", model }).next({
      context: JSON.stringify({
        agent: {
          name: "Gmail",
          initialUrl: "https://mail.google.com/",
          instructions: "",
        },
        currentTime: "2026-09-12T15:00:00.000Z",
        timezone: "America/Lima",
        task: "Find the [ORBIT-TEST] meeting request and hand the meeting details to the Calendar agent.",
        overallWorkflowGoal:
          "Read the request, then create the event after approval.",
        handoffRole:
          "Produce relevant structured information for the next connected agent. Do not operate the next agent’s website.",
        explicitlyTransferredContext: null,
        ownChat: [],
        observableResults: [],
      }),
      pageText:
        "URL: https://mail.google.com/mail/u/0/#inbox/orbit-test\nTitle: [ORBIT-TEST] Meeting request - Gmail\n[ORBIT-TEST] Meeting request\nFrom: Orbit Demo <orbit-demo@example.com>\nCan we meet on Thursday, October 1, 2026 at 15:00 America/Lima for 45 minutes? Subject: ORBIT-TEST demo review. No other guests.\nCONTROLS: []",
      signal: AbortSignal.timeout(90000),
    });
    expect(stepSchema.parse(step)).toEqual(step);
    // Only observable fields: no reasoning or extra provider output.
    expect(Object.keys(step).sort()).toEqual([
      "data",
      "impact",
      "instruction",
      "kind",
      "summary",
      "url",
    ]);
    expect(["finish", "extract"]).toContain(step.kind);
    if (step.kind === "finish")
      expect(JSON.stringify(structuredData(step.data))).toMatch(
        /2026|October|10-01/,
      );
    console.info(`Gemini planner step: ${step.kind} · ${step.summary}`);
  });

  it("resolves targets and extracts facts with Stagehand in real Chrome, without executing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-live-test-"));
    const store = new WorkspaceStore(root);
    await store.init();
    const fixtures = await startFixtures();
    const browsers = new BrowserManager(store, { headless: true });
    cleanups.push(async () => {
      await browsers.closeAll();
      await store.flush();
      await fixtures.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const project = await store.create("Live Gemini");
    const agent = await store.addAgent(project.id, {
      name: "Calendar",
      url: `${fixtures.url}/calendar`,
      preset: "calendar",
      instructions: "",
      provider: { provider: "gemini", model },
    });
    await browsers.open(project.id, agent.id);

    const fill = await browsers.resolve(
      project.id,
      agent.id,
      "Type 'ORBIT-TEST review' into the Event title field",
    );
    const fillTarget = await browsers.evidence(project.id, agent.id, fill);
    expect(["fill", "type"]).toContain(fill.method);
    expect(fillTarget.editable).toBe(true);
    expect(
      requiresApproval(
        { impact: "read", instruction: "Type the title" },
        fill,
        fillTarget,
      ),
    ).toBe(true);

    const create = await browsers.resolve(
      project.id,
      agent.id,
      "Click the Create event button",
    );
    const createTarget = await browsers.evidence(project.id, agent.id, create);
    expect(createTarget.text).toContain("Create event");
    expect(
      requiresApproval(
        { impact: "read", instruction: "Click it" },
        create,
        createTarget,
      ),
    ).toBe(true);

    const facts = await browsers.extract(
      project.id,
      agent.id,
      "Extract the event date, time range and timezone shown on the page",
    );
    expect(`${facts.summary} ${facts.data}`).toMatch(/2026|October|15:00/);
    expect(fixtures.events).toHaveLength(0);
    console.info(
      `Stagehand with Gemini: ${fill.method} title field, click "${createTarget.text}", extracted "${facts.summary}"`,
    );
  });
});
