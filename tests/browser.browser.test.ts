import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { WorkspaceStore } from "../server/store.js";
import { BrowserManager } from "../server/browser.js";
import type { ProjectState } from "../shared/types.js";
import { Stagehand, AISdkClient } from "@browserbasehq/stagehand";
import { MockLanguageModelV2 } from "ai/test";

let root: string,
  store: WorkspaceStore,
  browsers: BrowserManager,
  project: ProjectState,
  fixture: Server,
  url: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-browser-test-"));
  store = new WorkspaceStore(root);
  await store.init();
  fixture = createServer((req, res) => {
    if (req.url === "/download") {
      res.writeHead(200, {
        "Content-Disposition": 'attachment; filename="meeting.txt"',
        "Content-Type": "text/plain",
      });
      res.end("Meeting notes");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Orbit browser fixture</title><h1>Meeting inbox</h1><label>Search<input type="search" id="search"></label><button id="read" onclick="document.querySelector(\'article\').textContent=\'Hackathon meeting: 2026-10-01 15:00 America/Lima, 60 minutes\'">Read meeting</button><article></article><a href="/download">Download notes</a>',
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  project = await store.create("Browser test");
  for (const name of ["Inbox", "Calendar"])
    await store.addAgent(project.id, {
      name,
      preset: "custom",
      url,
      instructions: "",
      provider: { provider: "openai", model: "gpt-4.1" },
    });
  browsers = new BrowserManager(store, {
    headless: true,
    previewInterval: 500,
  });
});
afterAll(async () => {
  await browsers?.closeAll();
  await store?.flush();
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
  if (root) await fs.rm(root, { recursive: true, force: true });
});
describe("real Chromium browser engine", () => {
  it("opens independent profiles, reads, clicks, types, captures and downloads into the right agent folder", async () => {
    const [a, b] = project.agents;
    const first = await browsers.open(project.id, a.id);
    const second = await browsers.open(project.id, b.id);
    expect(first.cdpUrl).not.toBe(second.cdpUrl);
    await first.context.addCookies([
      { name: "orbitSession", value: "inbox-only", url },
    ]);
    await first.page.evaluate(() => localStorage.setItem("workspace", "inbox"));
    expect(
      (await second.context.cookies()).find((c) => c.name === "orbitSession"),
    ).toBeUndefined();
    expect(
      await second.page.evaluate(() => localStorage.getItem("workspace")),
    ).toBeNull();
    await browsers.execute(project.id, a.id, {
      selector: "#search",
      description: "Search",
      method: "fill",
      arguments: ["hackathon"],
    });
    expect(await first.page.inputValue("#search")).toBe("hackathon");
    await browsers.execute(project.id, a.id, {
      selector: "#read",
      description: "Read meeting",
      method: "click",
      arguments: [],
    });
    expect(await browsers.read(project.id, a.id)).toContain("2026-10-01");
    await browsers.capture(project.id, a.id);
    expect(browsers.preview(project.id, a.id)!.byteLength).toBeGreaterThan(
      1000,
    );
    await first.page.getByRole("link", { name: "Download notes" }).click();
    await expect.poll(() => a.artifacts.length).toBe(1);
    const file = path.join(
      store.agentPath(project.id, a.id),
      a.artifacts[0].relativePath,
    );
    expect(await fs.readFile(file, "utf8")).toBe("Meeting notes");
    expect(b.artifacts).toHaveLength(0);
    await browsers.close(project.id, a.id);
    const reopened = await browsers.open(project.id, a.id);
    expect(
      (await reopened.context.cookies()).find((c) => c.name === "orbitSession")
        ?.value,
    ).toBe("inbox-only");
    expect(
      await reopened.page.evaluate(() => localStorage.getItem("workspace")),
    ).toBe("inbox");
  });
  it("attaches actual Stagehand to the persistent Playwright browser and resolves an observed action", async () => {
    const a = project.agents[0];
    const session = await browsers.open(project.id, a.id);
    await session.page.locator("article").evaluate((el) => {
      el.textContent = "";
    });
    // Only inference is replaced. CDP, DOM snapshotting, Stagehand and browser execution are real.
    const model = new MockLanguageModelV2({
      doGenerate: async (options) => {
        const prompt = options.prompt
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join("\n"),
          )
          .join("\n");
        const match = prompt.match(
          /\[(\d+-\d+)\][^\n]*?button[^\n]*?Read meeting/i,
        );
        if (!match)
          throw new Error(
            "Stagehand snapshot did not contain the fixture button.",
          );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                elements: [
                  {
                    elementId: match[1],
                    description: "Read meeting",
                    method: "click",
                    arguments: [],
                  },
                ],
              }),
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    const stagehand = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: { cdpUrl: session.cdpUrl },
      llmClient: new AISdkClient({ model }),
      keepAlive: true,
      disableAPI: true,
      selfHeal: false,
      verbose: 0,
      logger: () => {},
    });
    try {
      await stagehand.init();
      const [resolved] = await stagehand.observe(
        "Click the Read meeting button",
        { page: session.page },
      );
      expect(resolved.selector).toContain("xpath=");
      await browsers.execute(project.id, a.id, {
        ...resolved,
        method: resolved.method!,
        arguments: resolved.arguments || [],
      });
      expect(await session.page.locator("article").innerText()).toContain(
        "Hackathon meeting",
      );
    } finally {
      await stagehand.close();
    }
    expect(session.page.isClosed()).toBe(false);
  });
});
