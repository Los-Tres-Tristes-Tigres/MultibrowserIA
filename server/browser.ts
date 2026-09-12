import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { WorkspaceStore } from "./store.js";
import { stagehandClient } from "./providers.js";
import { AppError, publicError, webUrl } from "./validation.js";
import type { BrowserAction, BrowserAgentRecord } from "../shared/types.js";
import type { TargetEvidence } from "./policy.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  cdpUrl: string;
  stagehand?: Stagehand;
  modelKey?: string;
  timer: ReturnType<typeof setInterval>;
  capturing: boolean;
  closing: boolean;
  generation: string;
  cookieSnapshot?: string;
}
// Methods returned by Stagehand observe() that Orbit executes itself. Drag-and-drop and coordinate input are not supported.
const ALLOWED_METHODS = new Set([
  "click",
  "doubleClick",
  "fill",
  "type",
  "press",
  "selectOption",
  "selectOptionFromDropdown",
  "check",
  "uncheck",
  "scrollTo",
  "scrollIntoView",
  "nextChunk",
  "prevChunk",
  "hover",
]);

export class BrowserManager {
  private sessions = new Map<string, BrowserSession>();
  private opening = new Map<string, Promise<BrowserSession>>();
  private previews = new Map<string, Buffer>();
  /** Local ports agents must never reach: Orbit itself and, in Docker, the noVNC viewer. */
  readonly blockedPorts = new Set<number>();
  constructor(
    readonly store: WorkspaceStore,
    private options: {
      headless?: boolean;
      channel?: string;
      executablePath?: string;
      previewInterval?: number;
    } = {},
  ) {}
  key(projectId: string, agentId: string) {
    return `${projectId}/${agentId}`;
  }
  preview(projectId: string, agentId: string) {
    return this.previews.get(this.key(projectId, agentId));
  }
  validateUrl(value: string) {
    const url = new URL(webUrl.parse(value));
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      this.blockedPorts.has(
        Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      )
    )
      throw new AppError(
        "Browser agents cannot navigate to the Orbit control server or its local services.",
      );
    return url.toString();
  }
  /** Last visited website, or the configured URL when the last page was internal (chrome://, about:blank). */
  startUrl(agent: BrowserAgentRecord) {
    try {
      return this.validateUrl(agent.currentUrl);
    } catch {
      return this.validateUrl(agent.url);
    }
  }
  async open(projectId: string, agentId: string): Promise<BrowserSession> {
    const key = this.key(projectId, agentId);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const existing = this.sessions.get(key);
    const operation =
      existing && !existing.closing
        ? this.restore(projectId, agentId, existing)
        : this.launch(projectId, agentId);
    this.opening.set(key, operation);
    try {
      return await operation;
    } finally {
      this.opening.delete(key);
    }
  }
  private async restore(
    projectId: string,
    agentId: string,
    session: BrowserSession,
  ) {
    if (!session.context.pages().some((page) => !page.isClosed())) {
      // Chrome keeps running after its last tab closes; bring a page back instead of failing on every open.
      session.page = await session.context.newPage();
      await session.page.goto(
        this.startUrl(this.store.agent(projectId, agentId)),
        { waitUntil: "domcontentloaded" },
      );
    }
    await this.currentPage(session).bringToFront();
    return session;
  }
  private async launch(projectId: string, agentId: string) {
    const agent = this.store.agent(projectId, agentId);
    const key = this.key(projectId, agentId);
    const profile = path.join(
      this.store.agentPath(projectId, agentId),
      "browser-profile",
    );
    const executablePath =
      this.options.executablePath ||
      process.env.ORBIT_BROWSER_EXECUTABLE_PATH ||
      undefined;
    const channel =
      this.options.channel ?? process.env.ORBIT_BROWSER_CHANNEL ?? "chrome";
    const context = await chromium
      .launchPersistentContext(profile, {
        ...(executablePath
          ? { executablePath }
          : channel === "chromium"
            ? {}
            : { channel }),
        headless: this.options.headless ?? false,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
        args: [
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
        ],
      })
      .catch((error) => {
        throw new AppError(
          `Browser could not start. Install Google Chrome or set ORBIT_BROWSER_CHANNEL=chromium after running npx playwright install chromium. ${publicError(error).split("\n")[0]}`,
          500,
        );
      });
    try {
      const portFile = (
        await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n");
      const sessionFile = path.join(profile, "orbit-session.json");
      const cookieData = await fs
        .readFile(sessionFile, "utf8")
        .catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
      if (cookieData) {
        const cookies = z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string(),
              path: z.string(),
              expires: z.number(),
              httpOnly: z.boolean(),
              secure: z.boolean(),
              sameSite: z.enum(["Strict", "Lax", "None"]),
            }),
          )
          .parse(JSON.parse(cookieData));
        await context.addCookies(cookies);
      }
      const page = context.pages()[0] || (await context.newPage());
      const session: BrowserSession = {
        context,
        page,
        cdpUrl: `ws://127.0.0.1:${Number(portFile[0])}${portFile[1].trim()}`,
        timer: undefined as never,
        capturing: false,
        closing: false,
        generation: randomUUID(),
      };
      this.sessions.set(key, session);
      await context.route("**/*", async (route) => {
        try {
          this.validateUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      const watch = (p: Page) => {
        p.setDefaultTimeout(15000);
        p.setDefaultNavigationTimeout(45000);
        p.on("download", (download) => {
          void (async () => {
            const basename =
              path
                .basename(download.suggestedFilename())
                .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
                .slice(0, 180) || "download";
            const id = randomUUID();
            const name = `${id.slice(0, 8)}-${basename}`;
            const relativePath = path.join("downloads", name);
            await download.saveAs(
              path.join(this.store.agentPath(projectId, agentId), relativePath),
            );
            agent.artifacts.push({
              id,
              name: basename,
              kind: "download",
              relativePath,
              createdAt: new Date().toISOString(),
            });
            await this.store.log(
              projectId,
              `Downloaded ${basename}`,
              agentId,
              agent.activeRunId,
              "success",
            );
          })().catch((error) =>
            this.store
              .log(
                projectId,
                `Download failed: ${publicError(error)}`,
                agentId,
                agent.activeRunId,
                "error",
              )
              .catch(() => {}),
          );
        });
      };
      context.pages().forEach(watch);
      context.on("page", (p) => {
        watch(p);
        session.page = p;
      });
      context.on("close", () => {
        clearInterval(session.timer);
        session.closing = true;
        if (this.sessions.get(key) === session) this.sessions.delete(key);
        agent.browserOpen = false;
        if (agent.activeRunId)
          this.store.emit("browserClosed", { projectId, agentId });
        else {
          agent.status = "Idle";
          agent.currentAction = "Browser closed · session saved";
        }
        void session.stagehand?.close().catch(() => {});
        void this.store.save(projectId).catch(() => {});
      });
      agent.browserOpen = true;
      const startUrl = this.startUrl(agent);
      try {
        await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        // Keep the window open so the user can retry, navigate or log in manually.
        await this.store.log(
          projectId,
          `Could not load ${new URL(startUrl).hostname}: ${publicError(error).split("\n")[0]}`,
          agentId,
          agent.activeRunId,
          "error",
        );
      }
      await page.bringToFront();
      if (!agent.activeRunId) {
        agent.currentAction = "Browser ready · log in manually if needed";
        agent.status = "Idle";
      }
      session.timer = setInterval(() => {
        void this.capture(projectId, agentId).catch(() => {});
      }, this.options.previewInterval ?? 2000);
      session.timer.unref();
      await this.capture(projectId, agentId);
      await this.store.log(
        projectId,
        `Opened ${new URL(startUrl).hostname}`,
        agentId,
      );
      return session;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
  currentPage(session: BrowserSession) {
    if (session.page.isClosed()) {
      const pages = session.context.pages().filter((p) => !p.isClosed());
      if (!pages.length)
        throw new AppError("Browser closed. Open it again to continue.", 409);
      session.page = pages.at(-1)!;
    }
    return session.page;
  }
  session(projectId: string, agentId: string) {
    const s = this.sessions.get(this.key(projectId, agentId));
    if (!s || s.closing)
      throw new AppError("Open this agent’s browser first.", 409);
    return s;
  }
  async capture(projectId: string, agentId: string) {
    const session = this.sessions.get(this.key(projectId, agentId));
    if (!session || session.capturing || session.closing) return;
    session.capturing = true;
    try {
      const page = this.currentPage(session);
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: 55,
        scale: "css",
        timeout: 5000,
      });
      this.previews.set(this.key(projectId, agentId), buffer);
      await this.saveSessionCookies(projectId, agentId, session);
      const agent = this.store.agent(projectId, agentId);
      // Remember websites only: internal pages (chrome://, about:blank) cannot be reopened later.
      const url = page.url();
      const changed =
        webUrl.safeParse(url).success && agent.currentUrl !== url;
      if (changed) agent.currentUrl = url;
      agent.pageTitle = await page.title().catch(() => "");
      this.store.emit("preview", { projectId, agentId, timestamp: Date.now() });
      if (changed) await this.store.save(projectId);
    } finally {
      session.capturing = false;
    }
  }
  private async saveSessionCookies(
    projectId: string,
    agentId: string,
    session: BrowserSession,
  ) {
    const data = JSON.stringify(
      (await session.context.cookies()).filter(
        (cookie) => cookie.expires === -1,
      ),
    );
    if (data === session.cookieSnapshot) return;
    const target = path.join(
      this.store.agentPath(projectId, agentId),
      "browser-profile",
      "orbit-session.json",
    );
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, target);
    session.cookieSnapshot = data;
  }
  async automation(projectId: string, agentId: string) {
    const s = this.session(projectId, agentId);
    const config = this.store.agent(projectId, agentId).provider;
    const modelKey = JSON.stringify(config);
    if (s.stagehand && s.modelKey !== modelKey) {
      await s.stagehand.close();
      s.stagehand = undefined;
    }
    if (!s.stagehand) {
      const stagehand = new Stagehand({
        env: "LOCAL",
        localBrowserLaunchOptions: { cdpUrl: s.cdpUrl },
        llmClient: stagehandClient(config),
        keepAlive: true,
        disableAPI: true,
        selfHeal: false,
        verbose: 0,
        logInferenceToFile: false,
        logger: () => {},
      });
      await stagehand.init();
      s.stagehand = stagehand;
      s.modelKey = modelKey;
    }
    return s.stagehand;
  }
  async read(projectId: string, agentId: string) {
    const s = this.session(projectId, agentId);
    const page = this.currentPage(s);
    // Text content and control labels, never input passwords or browser storage.
    const body = await page.locator("body").innerText({ timeout: 10000 });
    const controls = await page
      .locator(
        "a,button,input:not([type=password]),textarea,select,[role=button],[role=link]",
      )
      .evaluateAll((elements) =>
        elements.slice(0, 140).map((el) => ({
          tag: el.tagName,
          text: (el.textContent || "").slice(0, 120),
          label:
            el.getAttribute("aria-label") || el.getAttribute("placeholder"),
          type: el.getAttribute("type"),
          href: el.getAttribute("href"),
        })),
      );
    return `URL: ${page.url()}\nTitle: ${await page.title()}\n${body.slice(0, 28000)}\nCONTROLS: ${JSON.stringify(controls)}`;
  }
  async resolve(
    projectId: string,
    agentId: string,
    instruction: string,
  ): Promise<BrowserAction> {
    const stagehand = await this.automation(projectId, agentId);
    const page = this.currentPage(this.session(projectId, agentId));
    const actions = await stagehand.observe(
      `Find exactly ONE action: ${instruction}. Do not execute.`,
      { page, timeout: 45000 },
    );
    const action = actions[0];
    if (!action?.method || !ALLOWED_METHODS.has(action.method))
      throw new AppError(
        "Could not resolve a supported, single browser action. Try a more specific instruction.",
      );
    return {
      selector: action.selector,
      method: action.method,
      arguments: action.arguments || [],
      description: action.description,
    };
  }
  locator(projectId: string, agentId: string, action: BrowserAction): Locator {
    const page = this.currentPage(this.session(projectId, agentId));
    const selector = action.selector.startsWith("/")
      ? `xpath=${action.selector}`
      : action.selector;
    return page.locator(selector);
  }
  async evidence(
    projectId: string,
    agentId: string,
    action: BrowserAction,
  ): Promise<TargetEvidence> {
    const locator = this.locator(projectId, agentId, action);
    if ((await locator.count()) !== 1)
      throw new AppError(
        "Action target changed or is ambiguous. Start a fresh task.",
      );
    // Runs in the page: no named inner functions. tsx (npm run dev) wraps those in a __name helper the page lacks.
    const target = await locator.evaluate((el) => {
      const fieldSelector =
        "input:not([type=hidden]):not([type=password]),textarea,select,[contenteditable]:not([contenteditable=false])";
      // Logical form: an explicit form or dialog, else the nearest container with fields (formless web apps).
      const explicit = el.closest("form,[role=dialog],[role=alertdialog]");
      let scope: Element | null = explicit;
      for (
        let node = el.parentElement;
        !scope && node && node !== document.body;
        node = node.parentElement
      )
        if (node.querySelector(fieldSelector)) scope = node;
      const nodes = scope
        ? Array.from(scope.querySelectorAll(fieldSelector)).slice(0, 80)
        : [];
      // One pass describes the target and then every field.
      const described = [el, ...nodes].map((node) => {
        const raw =
          node instanceof HTMLInputElement
            ? ["checkbox", "radio"].includes(node.type)
              ? String(node.checked)
              : node.value
            : node instanceof HTMLTextAreaElement ||
                node instanceof HTMLSelectElement
              ? node.value
              : node.textContent || "";
        return {
          label: [
            node.getAttribute("aria-label"),
            node.getAttribute("placeholder"),
            node.getAttribute("name"),
            node.getAttribute("title"),
            ...(node instanceof HTMLInputElement ||
            node instanceof HTMLTextAreaElement ||
            node instanceof HTMLSelectElement
              ? Array.from(node.labels || []).map((l) => l.textContent)
              : []),
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300),
          // Payment fields: detect changes without copying the value into the approval.
          value: node.getAttribute("autocomplete")?.startsWith("cc-")
            ? `(hidden, ${raw.length} characters)`
            : raw.replace(/\s+/g, " ").trim().slice(0, 4000),
        };
      });
      const scopeText = (scope?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 14000);
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const label = described[0].label;
      return {
        tag,
        role: el.getAttribute("role") || "",
        type,
        label,
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
        href: el instanceof HTMLAnchorElement ? el.href : "",
        inSearch: Boolean(
          el.closest("[role=search]") ||
            type === "search" ||
            /\b(search|buscar|búsqueda)\b/i.test(label),
        ),
        editable:
          ["input", "textarea", "select"].includes(tag) ||
          (el instanceof HTMLElement && el.isContentEditable),
        attributes: [
          "name",
          "type",
          "role",
          "aria-label",
          "placeholder",
          "title",
          "href",
          "value",
          "disabled",
          "aria-disabled",
          "aria-checked",
          "aria-selected",
        ]
          .map((name) => `${name}=${el.getAttribute(name) ?? ""}`)
          .join("|"),
        fields: described.slice(1),
        // Large page containers change constantly (new mail, counters); only forms, dialogs and compact containers add text.
        formText: explicit || scopeText.length < 10000 ? scopeText : "",
      };
    });
    if (target.type === "password")
      throw new AppError(
        "Login must be performed manually in Open Browser.",
        409,
      );
    return {
      ...target,
      url: this.currentPage(this.session(projectId, agentId)).url(),
    };
  }
  async execute(projectId: string, agentId: string, action: BrowserAction) {
    if (!ALLOWED_METHODS.has(action.method))
      throw new AppError("Unsupported browser action.");
    const locator = this.locator(projectId, agentId, action);
    const arg = action.arguments[0] || "";
    // Deterministic execution of the resolved action. No self-healing or hidden re-planning.
    switch (action.method) {
      case "click":
        await locator.click();
        break;
      case "doubleClick":
        await locator.dblclick();
        break;
      case "fill":
        await locator.fill(arg);
        break;
      case "type":
        await locator.pressSequentially(arg);
        break;
      case "press":
        if (
          !/^(Enter|Escape|Tab|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Backspace|Delete|Home|End|PageDown|PageUp|Space)$/.test(
            arg,
          )
        )
          throw new AppError("Unsupported key.");
        await locator.press(arg);
        break;
      case "selectOption":
      case "selectOptionFromDropdown":
        await locator.selectOption(arg);
        break;
      case "check":
        await locator.check();
        break;
      case "uncheck":
        await locator.uncheck();
        break;
      case "hover":
        await locator.hover();
        break;
      case "scrollIntoView":
        await locator.scrollIntoViewIfNeeded();
        break;
      case "scrollTo":
      case "nextChunk":
      case "prevChunk":
        await locator.evaluate(
          (el, { method, value }) => {
            const whole = el === document.body || el === document.documentElement;
            const box = whole
              ? document.scrollingElement || document.documentElement
              : el;
            // Stagehand expresses scrollTo positions as percentages ("50%").
            const percent = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
            if (method === "scrollTo" && percent) {
              box.scrollTo({
                top:
                  ((box.scrollHeight - box.clientHeight) * Number(percent[1])) /
                  100,
              });
              return;
            }
            const height = whole ? window.innerHeight : box.clientHeight;
            const direction =
              method === "prevChunk" || value === "up" ? -1 : 1;
            box.scrollBy({ top: direction * Math.max(200, height * 0.85) });
          },
          { method: action.method, value: arg },
        );
        break;
    }
    await this.currentPage(this.session(projectId, agentId)).waitForTimeout(
      350,
    );
    await this.capture(projectId, agentId);
  }
  async navigate(projectId: string, agentId: string, url: string) {
    await this.currentPage(this.session(projectId, agentId)).goto(
      this.validateUrl(url),
      { waitUntil: "domcontentloaded" },
    );
    await this.capture(projectId, agentId);
  }
  async extract(projectId: string, agentId: string, instruction: string) {
    const stagehand = await this.automation(projectId, agentId);
    return stagehand.extract(
      instruction,
      z.object({
        summary: z.string(),
        data: z
          .string()
          .describe(
            "A JSON object of grounded extracted facts. Preserve unknown values as null; use absolute dates and timezone only when known.",
          ),
      }),
      {
        page: this.currentPage(this.session(projectId, agentId)),
        timeout: 45000,
      },
    );
  }
  async close(projectId: string, agentId: string) {
    const key = this.key(projectId, agentId);
    await this.opening.get(key)?.catch(() => {});
    const s = this.sessions.get(key);
    if (!s) return;
    s.closing = true;
    clearInterval(s.timer);
    await this.saveSessionCookies(projectId, agentId, s).catch(() => {});
    await s.stagehand?.close().catch(() => {});
    await s.context.close();
    this.sessions.delete(key);
    this.previews.delete(key);
    const agent = this.store.agent(projectId, agentId);
    agent.browserOpen = false;
    await this.store.save(projectId);
  }
  async closeAll() {
    await Promise.all(
      [...this.sessions.keys()].map((key) => {
        const [projectId, agentId] = key.split("/");
        return this.close(projectId, agentId).catch(() => {});
      }),
    );
  }
}
