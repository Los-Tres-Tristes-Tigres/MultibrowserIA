import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../server/store.js";
import { AgentRuntime } from "../server/runtime.js";
import { FixtureBrowser, fixturePlanner, startFixtures } from "./fixtures.js";
import type { ProjectState } from "../shared/types.js";

let store: WorkspaceStore,
  browser: FixtureBrowser,
  runtime: AgentRuntime,
  fixtures: Awaited<ReturnType<typeof startFixtures>>,
  root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-runtime-test-"));
  store = new WorkspaceStore(root);
  await store.init();
  fixtures = await startFixtures();
  browser = new FixtureBrowser(store, {
    headless: true,
    previewInterval: 1000,
  });
  runtime = new AgentRuntime(store, browser, {
    planner: fixturePlanner,
    checkProvider: () => {},
  });
});
afterAll(async () => {
  await runtime?.shutdown();
  await store?.flush();
  await fixtures?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function project() {
  const p = await store.create("Workflow test", true);
  p.agents[0].url = p.agents[0].currentUrl = fixtures.url + "/inbox";
  p.agents[1].url = p.agents[1].currentUrl = fixtures.url + "/calendar";
  await store.save(p.id);
  return p;
}
async function nextApproval(p: ProjectState) {
  await expect
    .poll(() => p.approvals.find((a) => a.status === "pending"), {
      timeout: 30000,
    })
    .toBeTruthy();
  return p.approvals.find((a) => a.status === "pending")!;
}
it("hands context to a separate browser; nothing executes before approval and a decision executes only once", async () => {
  const p = await project();
  const before = fixtures.events.length;
  const run = await runtime.start(
    p.id,
    p.agents[0].id,
    p.workflows[0].instruction,
    p.workflows[0].id,
  );
  const first = await nextApproval(p);
  expect(fixtures.events.length).toBe(before);
  expect(p.messages[0].data.title).toBe("Hackathon meeting");
  expect(
    await browser.session(p.id, p.agents[1].id).page.inputValue("#event-title"),
  ).toBe("");
  await runtime.decide(p.id, first.id, true);
  await expect(runtime.decide(p.id, first.id, true)).rejects.toThrow("already");
  const second = await nextApproval(p);
  expect(second.id).not.toBe(first.id);
  expect(fixtures.events.length).toBe(before);
  await runtime.decide(p.id, second.id, true);
  await runtime.wait(run.id);
  expect(run.status).toBe("completed");
  expect(fixtures.events.length).toBe(before + 1);
  expect(p.agents[1].lastResult?.data.created).toBe(true);
  expect(p.agents[0].chatHistory.some((c) => c.role === "handoff")).toBe(false);
  expect(p.agents[1].chatHistory.some((c) => c.role === "handoff")).toBe(true);
  await browser.close(p.id, p.agents[0].id);
  await browser.close(p.id, p.agents[1].id);
});
it("rejecting an approval cancels the entire chain without clicking or filling", async () => {
  const p = await project();
  const before = fixtures.events.length;
  const run = await runtime.start(
    p.id,
    p.agents[0].id,
    "Read request and create meeting",
    p.workflows[0].id,
  );
  const approval = await nextApproval(p);
  await runtime.decide(p.id, approval.id, false);
  await runtime.wait(run.id);
  expect(run.status).toBe("cancelled");
  expect(fixtures.events.length).toBe(before);
  expect(
    await browser.session(p.id, p.agents[1].id).page.inputValue("#event-title"),
  ).toBe("");
  await browser.close(p.id, p.agents[0].id);
  await browser.close(p.id, p.agents[1].id);
});
it("invalidates approval if the user changes the target form while the agent waits", async () => {
  const p = await project();
  const run = await runtime.start(
    p.id,
    p.agents[0].id,
    "Create meeting",
    p.workflows[0].id,
  );
  const approval = await nextApproval(p);
  await browser
    .session(p.id, p.agents[1].id)
    .page.fill("#event-title", "Changed by user");
  await runtime.decide(p.id, approval.id, true);
  await runtime.wait(run.id);
  expect(run.status).toBe("error");
  expect(run.error).toContain("changed");
  expect(
    await browser.session(p.id, p.agents[1].id).page.inputValue("#event-title"),
  ).toBe("Changed by user");
  await browser.close(p.id, p.agents[0].id);
  await browser.close(p.id, p.agents[1].id);
});

it("waits for a human clarification, rejects overlapping tasks and resumes with only that agent's reply", async () => {
  const p = await project();
  let calls = 0;
  const humanRuntime = new AgentRuntime(store, browser, {
    checkProvider: () => {},
    planner: () => ({
      next: async ({ context }) => {
        if (++calls === 1)
          return {
            kind: "ask",
            instruction: "Which timezone?",
            summary: "Which timezone?",
            impact: "read",
            url: null,
            data: "{}",
          };
        expect(context).toContain("America/Lima");
        return {
          kind: "finish",
          instruction: "",
          summary: "Timezone received.",
          impact: "read",
          url: null,
          data: '{"timezone":"America/Lima"}',
        };
      },
    }),
  });
  const a = p.agents[0];
  const run = await humanRuntime.start(p.id, a.id, "Read my request");
  await expect.poll(() => a.waitingForReply, { timeout: 15000 }).toBe(true);
  await expect(humanRuntime.start(p.id, a.id, "Another task")).rejects.toThrow(
    "active task",
  );
  await humanRuntime.reply(p.id, a.id, "America/Lima");
  await humanRuntime.wait(run.id);
  expect(run.status).toBe("completed");
  expect(a.waitingForReply).toBeUndefined();
  expect(p.agents[1].chatHistory).toHaveLength(0);
  await browser.close(p.id, a.id);
});

it("requires approval before a Slack post and only sends the approved message", async () => {
  const p = await store.create("Slack approval test");
  const slack = await store.addAgent(p.id, {
    name: "Slack",
    preset: "slack",
    url: `${fixtures.url}/inbox`,
    instructions: "",
    provider: { provider: "openrouter", model: "openrouter/free" },
  });
  slack.currentUrl = slack.url;
  await store.save(p.id);
  const posted: Array<{ channel: string; text: string; threadTs?: string }> =
    [];
  const slackRuntime = new AgentRuntime(store, browser, {
    checkProvider: () => {},
    planner: () => {
      let step = 0;
      return {
        next: async () => {
          if (++step === 1)
            return {
              kind: "post_to_slack" as const,
              instruction: "Demo ready",
              url: "#informal",
              impact: "external" as const,
              summary: "Post the demo update",
              data: "{}",
            };
          return {
            kind: "finish" as const,
            instruction: "",
            url: null,
            impact: "read" as const,
            summary: "Slack update sent.",
            data: "{}",
          };
        },
      };
    },
    postToSlack: async (channel, text, threadTs) => {
      posted.push({ channel, text, threadTs });
      return { channel, ts: "123.456" };
    },
  });

  const rejected = await slackRuntime.start(p.id, slack.id, "Post demo update");
  const rejectedApproval = await nextApproval(p);
  expect(rejectedApproval.action).toEqual({
    method: "post_to_slack",
    channel: "#informal",
    text: "Demo ready",
  });
  expect(posted).toEqual([]);
  await slackRuntime.decide(p.id, rejectedApproval.id, false);
  await slackRuntime.wait(rejected.id);
  expect(rejected.status).toBe("cancelled");
  expect(posted).toEqual([]);

  const accepted = await slackRuntime.start(p.id, slack.id, "Post demo update");
  const acceptedApproval = await nextApproval(p);
  await slackRuntime.decide(p.id, acceptedApproval.id, true);
  await slackRuntime.wait(accepted.id);
  expect(accepted.status).toBe("completed");
  expect(posted).toEqual([
    { channel: "#informal", text: "Demo ready", threadTs: undefined },
  ]);
  await browser.close(p.id, slack.id);
  await slackRuntime.shutdown();
});
