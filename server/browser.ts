import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { WorkspaceStore } from "./store.js";
import { stagehandClient } from "./providers.js";
import { AppError, publicError, webUrl } from "./validation.js";
import type { BrowserAction } from "../shared/types.js";
import type { TargetEvidence } from "./policy.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  cdpUrl: string;
  workspace: WorkspaceBrowser;
  stagehand?: Stagehand;
  modelKey?: string;
  timer: ReturnType<typeof setInterval>;
  capturing: boolean;
  closing: boolean;
  generation: string;
}
interface WorkspaceBrowser {
  context: BrowserContext;
  cdpUrl: string;
  profile?: string;
  browser?: Browser;
  connected: boolean;
  closing: boolean;
  cookieSnapshot?: string;
}
const ALLOWED_METHODS = new Set([
  "click",
  "fill",
  "type",
  "press",
  "selectOption",
  "check",
  "uncheck",
  "scrollTo",
  "scrollIntoView",
  "hover",
]);

export class BrowserManager {
  private sessions = new Map<string, BrowserSession>();
  private opening = new Map<string, Promise<BrowserSession>>();
  private workspaces = new Map<string, WorkspaceBrowser>();
  private openingWorkspaces = new Map<string, Promise<WorkspaceBrowser>>();
  private previews = new Map<string, Buffer>();
  blockedPort?: number;
  constructor(
    readonly store: WorkspaceStore,
    private options: {
      headless?: boolean;
      channel?: string;
      executablePath?: string;
      previewInterval?: number;
      cdpUrl?: string;
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
      this.blockedPort &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) ===
        this.blockedPort
    )
      throw new AppError(
        "Browser agents cannot navigate to the Orbit control server.",
      );
    return url.toString();
  }
  async open(projectId: string, agentId: string): Promise<BrowserSession> {
    const key = this.key(projectId, agentId);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const existing = this.sessions.get(key);
    if (existing && !existing.closing) {
      if (!existing.page.isClosed()) {
        await existing.page.bringToFront();
        return existing;
      }
      await this.close(projectId, agentId);
    }
    const operation = this.launch(projectId, agentId);
    this.opening.set(key, operation);
    try {
      return await operation;
    } finally {
      this.opening.delete(key);
    }
  }
  private async launch(projectId: string, agentId: string) {
    const agent = this.store.agent(projectId, agentId);
    const key = this.key(projectId, agentId);
    const workspace = await this.openWorkspace(projectId);
    const context = workspace.context;
    const page = await this.pageForAgent(workspace, projectId, agentId);
    const session: BrowserSession = {
      context,
      page,
      cdpUrl: workspace.cdpUrl,
      workspace,
      timer: undefined as never,
      capturing: false,
      closing: false,
      generation: randomUUID(),
    };
    this.sessions.set(key, session);
    const watch = (target: Page) => {
      target.setDefaultTimeout(15000);
      target.setDefaultNavigationTimeout(45000);
      target.on("download", (download) => {
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
    watch(page);
    page.on("popup", (popup) => {
      watch(popup);
      session.page = popup;
    });
    agent.browserOpen = true;
    if (!agent.activeRunId) {
      agent.currentAction = workspace.connected
        ? "Browser ready · connected Chrome tab"
        : "Browser ready · shared workspace session";
      agent.status = "Idle";
    }
    session.timer = setInterval(() => {
      void this.capture(projectId, agentId).catch(() => {});
    }, this.options.previewInterval ?? 2000);
    session.timer.unref();
    await this.capture(projectId, agentId);
    await this.store.log(
      projectId,
      `Opened ${new URL(agent.currentUrl || agent.url).hostname}`,
      agentId,
    );
    return session;
  }
  private async openWorkspace(projectId: string): Promise<WorkspaceBrowser> {
    const existing = this.workspaces.get(projectId);
    if (
      existing &&
      !existing.closing &&
      (!existing.browser || existing.browser.isConnected())
    )
      return existing;
    if (existing && this.workspaces.get(projectId) === existing)
      this.workspaces.delete(projectId);
    const pending = this.openingWorkspaces.get(projectId);
    if (pending) return pending;
    const operation = this.launchWorkspace(projectId);
    this.openingWorkspaces.set(projectId, operation);
    try {
      return await operation;
    } finally {
      this.openingWorkspaces.delete(projectId);
    }
  }
  private async launchWorkspace(projectId: string): Promise<WorkspaceBrowser> {
    const configuredCdpUrl =
      this.options.cdpUrl ?? process.env.ORBIT_BROWSER_CDP_URL;
    if (configuredCdpUrl?.trim())
      return this.connectWorkspace(projectId, configuredCdpUrl.trim());
    const profile = await this.workspaceProfile(projectId);
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
      const legacyCookies = await this.legacySessionCookies(projectId);
      if (legacyCookies.length) await context.addCookies(legacyCookies);
      const workspace: WorkspaceBrowser = {
        context,
        cdpUrl: `ws://127.0.0.1:${Number(portFile[0])}${portFile[1].trim()}`,
        profile,
        connected: false,
        closing: false,
      };
      if (cookieData) workspace.cookieSnapshot = cookieData;
      await context.route("**/*", async (route) => {
        try {
          this.validateUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      this.trackWorkspace(projectId, workspace);
      return workspace;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
  private localCdpEndpoint(value: string) {
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch {
      throw new AppError(
        "ORBIT_BROWSER_CDP_URL must be a local Chrome DevTools URL.",
        409,
      );
    }
    if (!new Set(["http:", "https:", "ws:", "wss:"]).has(endpoint.protocol))
      throw new AppError(
        "ORBIT_BROWSER_CDP_URL must use http, https, ws, or wss.",
        409,
      );
    if (
      !new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(
        endpoint.hostname.toLowerCase(),
      )
    )
      throw new AppError(
        "ORBIT_BROWSER_CDP_URL must point to a browser on this computer.",
        409,
      );
    if (endpoint.username || endpoint.password)
      throw new AppError(
        "ORBIT_BROWSER_CDP_URL cannot include credentials.",
        409,
      );
    return endpoint;
  }
  private async connectedCdpUrl(endpoint: URL) {
    if (endpoint.protocol === "ws:" || endpoint.protocol === "wss:")
      return endpoint.toString();
    const response = await fetch(new URL("/json/version", endpoint), {
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      throw new AppError(
        "Could not reach ORBIT_BROWSER_CDP_URL. Enable a local Chrome DevTools endpoint first.",
        409,
      );
    });
    if (!response.ok)
      throw new AppError(
        "ORBIT_BROWSER_CDP_URL did not respond as a Chrome DevTools endpoint.",
        409,
      );
    const metadata = z
      .object({ webSocketDebuggerUrl: z.string().min(1) })
      .safeParse(await response.json());
    if (!metadata.success)
      throw new AppError(
        "ORBIT_BROWSER_CDP_URL did not return a Chrome DevTools websocket.",
        409,
      );
    return this.localCdpEndpoint(metadata.data.webSocketDebuggerUrl).toString();
  }
  private async connectWorkspace(projectId: string, value: string) {
    const endpoint = this.localCdpEndpoint(value);
    const cdpUrl = await this.connectedCdpUrl(endpoint);
    const browser = await chromium
      .connectOverCDP(endpoint.toString(), { timeout: 15000 })
      .catch((error) => {
        throw new AppError(
          `Could not connect to ORBIT_BROWSER_CDP_URL. ${publicError(error).split("\n")[0]}`,
          409,
        );
      });
    try {
      const context = browser.contexts()[0];
      if (!context)
        throw new AppError(
          "The connected Chrome instance has no default browser context.",
          409,
        );
      const workspace: WorkspaceBrowser = {
        context,
        cdpUrl,
        browser,
        connected: true,
        closing: false,
      };
      this.trackWorkspace(projectId, workspace);
      return workspace;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
  private trackWorkspace(projectId: string, workspace: WorkspaceBrowser) {
    this.workspaces.set(projectId, workspace);
    workspace.context.on("close", () => {
      workspace.closing = true;
      if (this.workspaces.get(projectId) === workspace)
        this.workspaces.delete(projectId);
      for (const [sessionKey, session] of this.sessions) {
        if (session.workspace !== workspace) continue;
        clearInterval(session.timer);
        session.closing = true;
        this.sessions.delete(sessionKey);
        this.previews.delete(sessionKey);
        const [, closedAgentId] = sessionKey.split("/");
        const closedAgent = this.store.agent(projectId, closedAgentId);
        closedAgent.browserOpen = false;
        if (closedAgent.activeRunId)
          this.store.emit("browserClosed", {
            projectId,
            agentId: closedAgentId,
          });
        else {
          closedAgent.status = "Idle";
          closedAgent.currentAction = workspace.connected
            ? "Connected Chrome closed"
            : "Browser closed · session saved";
        }
        void session.stagehand?.close().catch(() => {});
      }
      void this.store.save(projectId).catch(() => {});
    });
  }
  private async workspaceProfile(projectId: string) {
    const shared = path.join(this.store.projectPath(projectId), "browser-profile");
    if (await fs.stat(shared).catch(() => null)) return shared;
    const agents = [...this.store.get(projectId).agents].sort((left, right) => {
      const priority = (preset: string) =>
        ["gmail", "calendar", "slack"].indexOf(preset);
      return priority(left.preset) - priority(right.preset);
    });
    for (const agent of agents) {
      const legacy = path.join(
        this.store.agentPath(projectId, agent.id),
        "browser-profile",
      );
      const info = await fs.lstat(legacy).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const files = await fs.readdir(legacy).catch(() => []);
      if (!files.length) continue;
      await fs.cp(legacy, shared, {
        recursive: true,
        force: false,
        filter: (source) =>
          !["SingletonCookie", "SingletonLock", "SingletonSocket"].includes(
            path.basename(source),
          ),
      });
      break;
    }
    return shared;
  }
  private async legacySessionCookies(projectId: string) {
    const seen = new Set<string>();
    const result: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }> = [];
    for (const agent of this.store.get(projectId).agents) {
      const file = path.join(
        this.store.agentPath(projectId, agent.id),
        "browser-profile",
        "orbit-session.json",
      );
      try {
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
          .parse(JSON.parse(await fs.readFile(file, "utf8")));
        for (const cookie of cookies) {
          const id = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
          if (!seen.has(id)) {
            seen.add(id);
            result.push(cookie);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    }
    return result;
  }
  private matchesAgentTab(
    preset: string,
    pageUrl: string,
    targetOrigin: string,
  ) {
    try {
      const page = new URL(pageUrl);
      if (page.origin === targetOrigin) return true;
      if (preset === "calendar") return page.hostname === "calendar.google.com";
      if (preset === "slack")
        return (
          page.hostname === "app.slack.com" ||
          page.hostname.endsWith(".slack.com")
        );
      return false;
    } catch {
      return false;
    }
  }
  private async pageForAgent(
    workspace: WorkspaceBrowser,
    projectId: string,
    agentId: string,
  ) {
    const agent = this.store.agent(projectId, agentId);
    const target = this.validateUrl(agent.currentUrl || agent.url);
    const targetOrigin = new URL(target).origin;
    const attached = new Set(
      [...this.sessions.values()]
        .filter((session) => session.workspace === workspace)
        .map((session) => session.page),
    );
    const candidates = workspace.context
      .pages()
      .filter((page) => !page.isClosed() && !attached.has(page));
    const existing = candidates.find((page) => {
      return this.matchesAgentTab(agent.preset, page.url(), targetOrigin);
    });
    if (existing) {
      await existing.bringToFront();
      return existing;
    }
    if (workspace.connected)
      throw new AppError(
        `Open ${new URL(target).hostname} in the connected Chrome window, then open this browser again. Orbit will only use an existing tab in connected-Chrome mode.`,
        409,
      );
    const blank = candidates.find(
      (page) =>
        page.url() === "about:blank" || page.url().startsWith("chrome://newtab"),
    );
    const page = blank || (await workspace.context.newPage());
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    return page;
  }
  currentPage(session: BrowserSession) {
    if (session.page.isClosed())
      throw new AppError("This browser tab was closed. Open it again to continue.", 409);
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
      await this.saveSessionCookies(projectId, session.workspace);
      const agent = this.store.agent(projectId, agentId);
      const changed = agent.currentUrl !== page.url();
      agent.currentUrl = page.url();
      agent.pageTitle = await page.title().catch(() => "");
      this.store.emit("preview", { projectId, agentId, timestamp: Date.now() });
      if (changed) await this.store.save(projectId);
    } finally {
      session.capturing = false;
    }
  }
  private async saveSessionCookies(
    projectId: string,
    workspace: WorkspaceBrowser,
  ) {
    const profile = workspace.profile;
    if (workspace.connected || !profile) return;
    const data = JSON.stringify(
      (await workspace.context.cookies()).filter(
        (cookie) => cookie.expires === -1,
      ),
    );
    if (data === workspace.cookieSnapshot) return;
    const target = path.join(
      profile,
      "orbit-session.json",
    );
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, target);
    workspace.cookieSnapshot = data;
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
    const target = await locator.evaluate((el) => {
      const search = el.closest("[role=search],form[role=search]");
      const label = [
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        el.getAttribute("name"),
        el.getAttribute("title"),
        ...(el instanceof HTMLInputElement
          ? Array.from(el.labels || []).map((l) => l.textContent)
          : []),
      ]
        .filter(Boolean)
        .join(" ");
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const form = el.closest("form,[role=dialog]") || el.parentElement;
      const fields = form
        ? Array.from(
            form.querySelectorAll(
              "input:not([type=password]),textarea,select,[contenteditable=true]",
            ),
          ).map((node) => ({
            label: node.getAttribute("aria-label") || node.getAttribute("name"),
            value:
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLSelectElement
                ? node.value
                : node.textContent,
          }))
        : [];
      return {
        tag,
        role: el.getAttribute("role") || "",
        type,
        label,
        text: (el.textContent || "").slice(0, 500),
        href: el instanceof HTMLAnchorElement ? el.href : "",
        inSearch: Boolean(
          search ||
            type === "search" ||
            /\b(search|buscar|búsqueda)\b/i.test(label),
        ),
        editable:
          ["input", "textarea", "select"].includes(tag) ||
          el.getAttribute("contenteditable") === "true",
        html: el.outerHTML.slice(0, 12000),
        formState: JSON.stringify({
          fields,
          text: (form?.textContent || "").slice(0, 14000),
        }),
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
        await locator.evaluate((el, direction) => {
          const amount = direction === "up" ? -600 : 600;
          if (el === document.body || el === document.documentElement)
            window.scrollBy(0, amount);
          else el.scrollBy(0, amount);
        }, arg);
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
    if (!s.workspace.connected)
      await this.saveSessionCookies(projectId, s.workspace).catch(() => {});
    await s.stagehand?.close().catch(() => {});
    this.sessions.delete(key);
    this.previews.delete(key);
    if (!s.workspace.connected) await s.page.close().catch(() => {});
    const agent = this.store.agent(projectId, agentId);
    agent.browserOpen = false;
    await this.store.save(projectId);
    await this.closeWorkspaceIfUnused(projectId, s.workspace);
  }
  private async closeWorkspaceIfUnused(
    projectId: string,
    workspace: WorkspaceBrowser,
  ) {
    if (
      workspace.closing ||
      [...this.sessions.values()].some((session) => session.workspace === workspace)
    )
      return;
    workspace.closing = true;
    if (workspace.connected) await workspace.browser?.close().catch(() => {});
    else {
      await this.saveSessionCookies(projectId, workspace).catch(() => {});
      await workspace.context.close().catch(() => {});
    }
    if (this.workspaces.get(projectId) === workspace)
      this.workspaces.delete(projectId);
  }
  async closeAll() {
    await Promise.all(
      [...this.sessions.keys()].map((key) => {
        const [projectId, agentId] = key.split("/");
        return this.close(projectId, agentId).catch(() => {});
      }),
    );
    await Promise.all(
      [...this.workspaces.entries()].map(([projectId, workspace]) =>
        this.closeWorkspaceIfUnused(projectId, workspace),
      ),
    );
  }
}
