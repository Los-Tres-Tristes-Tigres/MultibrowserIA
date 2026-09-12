import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { WorkspaceStore } from "../server/store.js";
import { BrowserManager } from "../server/browser.js";
import { fingerprint } from "../server/policy.js";
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
    if (req.url === "/editor") {
      // A formless editor, like many web apps: the Save button is far from its fields.
      res.end(
        '<!doctype html><title>Editor fixture</title><main><div class="editor"><label>Title <input id="title" value="Demo"></label><div class="toolbar"><div><button id="save" class="idle">Save</button></div></div></div></main>',
      );
      return;
    }
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
  it("reopens at the configured website after an internal page or a closed last tab", async () => {
    const b = project.agents[1];
    await browsers.close(project.id, b.id);
    b.currentUrl = "chrome://new-tab-page/";
    const session = await browsers.open(project.id, b.id);
    expect(session.page.url()).toBe(`${url}/`);
    for (const page of session.context.pages()) await page.close();
    const restored = await browsers.open(project.id, b.id);
    expect(restored.page.isClosed()).toBe(false);
    expect(restored.page.url()).toBe(`${url}/`);
  });
  it("fingerprints a formless editor by its field values, not by cosmetic changes", async () => {
    const b = project.agents[1];
    const session = await browsers.open(project.id, b.id);
    await session.page.goto(`${url}/editor`);
    const save = {
      selector: "#save",
      description: "Save",
      method: "click",
      arguments: [],
    };
    const first = await browsers.evidence(project.id, b.id, save);
    expect(first.fields).toEqual([{ label: "Title", value: "Demo" }]);
    await session.page
      .locator("#save")
      .evaluate((el) => el.classList.replace("idle", "hovered"));
    expect(
      fingerprint(await browsers.evidence(project.id, b.id, save)),
    ).toBe(fingerprint(first));
    await session.page.fill("#title", "Changed by user");
    expect(
      fingerprint(await browsers.evidence(project.id, b.id, save)),
    ).not.toBe(fingerprint(first));
  });
  it("blocks Orbit and local control ports on every localhost name, and nothing else", () => {
    const guard = new BrowserManager(store);
    guard.blockedPorts.add(4173).add(6080);
    for (const blocked of [
      "http://127.0.0.1:4173/api/snapshot",
      "http://localhost:6080/vnc.html",
      "http://[::1]:4173/",
    ])
      expect(() => guard.validateUrl(blocked)).toThrow("Orbit");
    expect(guard.validateUrl("http://127.0.0.1:6081/")).toBe(
      "http://127.0.0.1:6081/",
    );
    expect(guard.validateUrl("https://calendar.google.com/")).toBe(
      "https://calendar.google.com/",
    );
  });
});
