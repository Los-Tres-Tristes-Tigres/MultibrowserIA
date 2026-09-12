/** Test-only pages and scripted planner. Production never imports this module. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserManager } from "../server/browser.js";
import type { AgentStep, Planner } from "../server/providers.js";
import type { BrowserAgentRecord } from "../shared/types.js";
const style =
  "<style>body{font:17px system-ui;margin:0;background:#f6f8fc;color:#233042}header{background:#fff;padding:22px 32px;border-bottom:1px solid #dce2ee;font-weight:600}main{margin:32px;background:white;border-radius:12px;padding:30px;max-width:900px}h1{font-size:24px}label{display:block;margin:18px 0}input{font:inherit;padding:12px;border:1px solid #cbd4e2;border-radius:8px}button,a{display:inline-block;font:inherit;padding:12px 18px;border:0;background:#1477ee;color:white;border-radius:8px;text-decoration:none;margin-right:10px}article{margin-top:25px;padding:24px;background:#edf5ff;border-radius:8px;line-height:1.9}.note{color:#718198;font-size:13px}</style>";
export async function startFixtures(port = 0) {
  const events: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/state") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ events }));
      return;
    }
    if (req.url === "/event" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      events.push(new URLSearchParams(body).get("title") || "Untitled");
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><title>Calendar fixture</title>${style}<header>Calendar · test website</header><main><h1>Event created</h1><p>Hackathon meeting · October 1, 2026 · 15:00–16:00 America/Lima</p><p>Saved events: ${events.length}</p></main>`,
      );
      return;
    }
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/inbox")
      res.end(
        `<!doctype html><title>Inbox fixture</title>${style}<header>Gmail · test website</header><main><h1>Inbox</h1><p class="note">Deterministic test fixture. No external account.</p><label>Search mail <input type="search" placeholder="Search mail"></label><article><strong>Hackathon meeting request</strong><p>Can we meet on October 1, 2026 at 15:00 America/Lima for 60 minutes?</p><p>Subject: Hackathon meeting</p></article></main>`,
      );
    else
      res.end(
        `<!doctype html><title>Calendar fixture</title>${style}<header>Calendar · test website</header><main><h1>New event</h1><p class="note">Deterministic test fixture. No external account.</p><form action="/event" method="post"><label>Event title <input id="event-title" name="title" autocomplete="off"></label><p>October 1, 2026 · 15:00–16:00 America/Lima</p><button id="save-event" type="submit">Create event</button></form></main>`,
      );
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return {
    server,
    events,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export class FixtureBrowser extends BrowserManager {
  override async resolve(
    projectId: string,
    agentId: string,
    instruction: string,
  ) {
    const page = this.currentPage(this.session(projectId, agentId));
    if (new URL(page.url()).hostname !== "127.0.0.1")
      throw new Error("Fixture driver is only allowed on test pages.");
    return instruction === "Enter event title"
      ? {
          selector: "#event-title",
          method: "fill",
          description: "Enter event title",
          arguments: ["Hackathon meeting"],
        }
      : {
          selector: "#save-event",
          method: "click",
          description: "Create event",
          arguments: [],
        };
  }
}
function step(partial: Partial<AgentStep>): AgentStep {
  return {
    kind: "finish",
    instruction: "",
    summary: "",
    url: null,
    impact: "read",
    data: "{}",
    ...partial,
  };
}
export function fixturePlanner(agent: BrowserAgentRecord): Planner {
  return {
    async next({ pageText, context }) {
      if (agent.name === "Gmail") {
        if (!pageText.includes("October 1, 2026"))
          throw new Error(
            "Inbox browser did not contain the expected request.",
          );
        return step({
          kind: "finish",
          summary: "Found Hackathon meeting request for October 1 at 15:00.",
          data: JSON.stringify({
            title: "Hackathon meeting",
            start: "2026-10-01T15:00:00-05:00",
            durationMinutes: 60,
            timezone: "America/Lima",
          }),
        });
      }
      const input = JSON.parse(context);
      if (pageText.includes("Event created"))
        return step({
          kind: "finish",
          summary: "Verified: Hackathon meeting was created in Calendar.",
          data: '{"created":true}',
        });
      if (!input.explicitlyTransferredContext?.data?.title)
        throw new Error("Calendar did not receive the Gmail result.");
      if (
        !input.observableResults.some((line: string) =>
          line.includes("Enter event title"),
        )
      )
        return step({
          kind: "act",
          instruction: "Enter event title",
          summary: "Enter event title",
          impact: "external",
        });
      return step({
        kind: "act",
        instruction: "Create event",
        summary: "Create event: Hackathon meeting",
        impact: "external",
      });
    },
  };
}
