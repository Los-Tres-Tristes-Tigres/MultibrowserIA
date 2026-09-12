import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Server } from "socket.io";
import { z, ZodError } from "zod";
import { WorkspaceStore } from "./store.js";
import { BrowserManager } from "./browser.js";
import { AgentRuntime } from "./runtime.js";
import { providerInfo } from "./providers.js";
import {
  agentInput,
  AppError,
  connectionInput,
  publicError,
  validateConnections,
} from "./validation.js";
import type { AppSnapshot } from "../shared/types.js";

export function createApp(
  store: WorkspaceStore,
  browsers: BrowserManager,
  runtime: AgentRuntime,
) {
  const app = express();
  const server = createServer(app);
  const isLocalHost = (host?: string) =>
    Boolean(host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host));
  const validOrigin = (origin: string | undefined, host: string | undefined) =>
    !origin || origin === `http://${host}`;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (
      !isLocalHost(req.headers.host) ||
      !validOrigin(req.headers.origin, req.headers.host)
    ) {
      res
        .status(403)
        .json({ error: "Orbit only accepts local, same-origin requests." });
      return;
    }
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    if (req.path.startsWith("/api/")) {
      res.set("Cache-Control", "no-store");
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        req.get("X-Orbit-Client") !== "local"
      ) {
        res.status(403).json({ error: "Missing local client header." });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  const io = new Server(server, {
    maxHttpBufferSize: 100000,
    allowRequest: (req, callback) =>
      callback(
        null,
        isLocalHost(req.headers.host) &&
          validOrigin(req.headers.origin, req.headers.host),
      ),
  });
  store.on("event", (event) => io.emit("orbit:event", event));
  store.on("preview", (event) => io.emit("orbit:preview", event));
  const textInput = z
    .object({ text: z.string().trim().min(1).max(12000) })
    .strict();
  const idleGraph = (id: string) => {
    if (store.get(id).agents.some((a) => a.activeRunId))
      throw new AppError(
        "Stop active tasks before editing this workflow.",
        409,
      );
  };

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/snapshot", (req, res) => {
    const projects = store.list();
    const projectId =
      typeof req.query.projectId === "string"
        ? req.query.projectId
        : projects[0]?.id;
    if (!projectId) throw new AppError("No workspace found.", 404);
    const payload: AppSnapshot = {
      project: store.get(projectId),
      projects,
      providers: providerInfo(),
      browser: {
        sharedSessionAvailable: browsers.sharedSessionAvailable,
        defaultSession: browsers.defaultSession,
      },
      workspacePath: store.projectPath(projectId),
    };
    res.json(payload);
  });
  app.post("/api/projects", async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        starter: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const available =
      providerInfo().find((p) => p.available) || providerInfo()[0];
    const p = await store.create(body.name, body.starter, {
      provider: available.id,
      model: available.defaultModel,
    });
    res.status(201).json({ id: p.id });
  });
  app.post("/api/projects/:projectId/agents", async (req, res) => {
    const input = agentInput.parse(req.body);
    const browserSession = input.browserSession ?? browsers.defaultSession;
    if (browserSession === "shared" && !browsers.sharedSessionAvailable)
      throw new AppError(
        "Shared Chrome sessions are available only in local desktop mode.",
        409,
      );
    const agent = await store.addAgent(req.params.projectId, {
      ...input,
      browserSession,
    });
    res.status(201).json(agent);
  });
  app.patch("/api/projects/:projectId/agents/:agentId", async (req, res) => {
    const { projectId, agentId } = req.params;
    const agent = store.agent(projectId, agentId);
    if (agent.activeRunId)
      throw new AppError("Stop this agent before changing its settings.", 409);
    const input = agentInput.partial().parse(req.body);
    if (input.browserSession === "shared" && !browsers.sharedSessionAvailable)
      throw new AppError(
        "Shared Chrome sessions are available only in local desktop mode.",
        409,
      );
    // The settings form always sends browserSession: only an actual change counts.
    const sessionChanged =
      input.browserSession !== undefined &&
      input.browserSession !== agent.browserSession;
    if (
      sessionChanged &&
      (agent.browserOpen || browsers.isOpening(projectId, agentId))
    )
      throw new AppError(
        "Close this agent’s browser before changing its session mode.",
        409,
      );
    Object.assign(agent, input);
    if (input.url) agent.currentUrl = input.url;
    if (sessionChanged)
      agent.currentAction =
        "Browser session changed · open browser to continue";
    await store.save(projectId);
    res.json(agent);
  });
  app.delete("/api/projects/:projectId/agents/:agentId", async (req, res) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const { projectId, agentId } = req.params;
    idleGraph(projectId);
    await browsers.close(projectId, agentId);
    await store.removeAgent(projectId, agentId);
    res.json({ deleted: true });
  });
  app.post(
    "/api/projects/:projectId/agents/:agentId/browser",
    async (req, res) => {
      await browsers.open(req.params.projectId, req.params.agentId);
      res.json({ opened: true });
    },
  );
  app.delete(
    "/api/projects/:projectId/agents/:agentId/browser",
    async (req, res) => {
      const { projectId, agentId } = req.params;
      const agent = store.agent(projectId, agentId);
      if (agent.activeRunId)
        throw new AppError(
          "Stop the active task before closing its browser.",
          409,
        );
      await browsers.close(projectId, agentId);
      res.json({ closed: true });
    },
  );
  app.get("/api/projects/:projectId/agents/:agentId/preview", (req, res) => {
    store.agent(req.params.projectId, req.params.agentId);
    const jpeg = browsers.preview(req.params.projectId, req.params.agentId);
    if (!jpeg) {
      res.status(204).end();
      return;
    }
    res.type("image/jpeg").send(jpeg);
  });
  app.post(
    "/api/projects/:projectId/agents/:agentId/messages",
    async (req, res) => {
      const { text } = textInput.parse(req.body);
      const { projectId, agentId } = req.params;
      const agent = store.agent(projectId, agentId);
      if (agent.activeRunId) {
        await runtime.reply(projectId, agentId, text);
        res.json({ replied: true });
      } else
        res.status(202).json(await runtime.start(projectId, agentId, text));
    },
  );
  app.get(
    "/api/projects/:projectId/agents/:agentId/artifacts/:artifactId",
    async (req, res) => {
      const { projectId, agentId, artifactId } = req.params;
      const a = store.agent(projectId, agentId);
      const artifact = a.artifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new AppError("Artifact not found.", 404);
      const base = store.agentPath(projectId, agentId);
      const file = path.resolve(base, artifact.relativePath);
      if (!file.startsWith(base + path.sep))
        throw new AppError("Invalid artifact path.", 403);
      // Never echo filesystem errors: they contain absolute local paths.
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat) throw new AppError("Artifact file is missing.", 404);
      if (!stat.isFile()) throw new AppError("Invalid artifact path.", 403);
      res.download(file, artifact.name);
    },
  );
  app.patch("/api/projects/:projectId/canvas", async (req, res) => {
    const body = z
      .object({
        positions: z
          .array(
            z.object({
              id: z.string(),
              x: z.number().finite(),
              y: z.number().finite(),
            }),
          )
          .max(200),
        viewport: z.object({
          x: z.number().finite(),
          y: z.number().finite(),
          zoom: z.number().min(0.15).max(2),
        }),
      })
      .strict()
      .parse(req.body);
    const p = store.get(req.params.projectId);
    for (const pos of body.positions) {
      const a = p.agents.find((a) => a.id === pos.id);
      if (a) a.position = { x: pos.x, y: pos.y };
    }
    p.viewport = body.viewport;
    await store.save(p.id);
    res.json({ saved: true });
  });
  app.post("/api/projects/:projectId/connections", async (req, res) => {
    const { projectId } = req.params;
    idleGraph(projectId);
    const p = store.get(projectId);
    const edge = { ...connectionInput.parse(req.body), id: randomUUID() };
    validateConnections(p.agents, [...p.connections, edge]);
    p.connections.push(edge);
    await store.save(projectId);
    res.status(201).json(edge);
  });
  app.patch(
    "/api/projects/:projectId/connections/:edgeId",
    async (req, res) => {
      const { projectId, edgeId } = req.params;
      idleGraph(projectId);
      const edge = store
        .get(projectId)
        .connections.find((e) => e.id === edgeId);
      if (!edge) throw new AppError("Connection not found.", 404);
      edge.instruction = z
        .object({ instruction: z.string().max(8000) })
        .strict()
        .parse(req.body).instruction;
      await store.save(projectId);
      res.json(edge);
    },
  );
  app.delete(
    "/api/projects/:projectId/connections/:edgeId",
    async (req, res) => {
      const { projectId, edgeId } = req.params;
      idleGraph(projectId);
      const p = store.get(projectId);
      p.connections = p.connections.filter((e) => e.id !== edgeId);
      await store.save(projectId);
      res.json({ deleted: true });
    },
  );
  app.post("/api/projects/:projectId/workflows", async (req, res) => {
    const { projectId } = req.params;
    idleGraph(projectId);
    const input = z
      .object({
        name: z.string().trim().min(1).max(70),
        startAgentId: z.string(),
        instruction: z.string().trim().min(1).max(12000),
      })
      .strict()
      .parse(req.body);
    store.agent(projectId, input.startAgentId);
    const workflow = { ...input, id: randomUUID() };
    store.get(projectId).workflows.push(workflow);
    await store.save(projectId);
    res.status(201).json(workflow);
  });
  app.post(
    "/api/projects/:projectId/workflows/:workflowId/run",
    async (req, res) => {
      const { projectId, workflowId } = req.params;
      const workflow = store
        .get(projectId)
        .workflows.find((w) => w.id === workflowId);
      if (!workflow) throw new AppError("Workflow not found.", 404);
      const { text } = textInput.parse(req.body);
      res
        .status(202)
        .json(
          await runtime.start(
            projectId,
            workflow.startAgentId,
            text,
            workflowId,
          ),
        );
    },
  );
  app.post("/api/projects/:projectId/runs/:runId/cancel", (req, res) => {
    runtime.cancel(req.params.projectId, req.params.runId);
    res.json({ stopping: true });
  });
  app.post(
    "/api/projects/:projectId/approvals/:approvalId",
    async (req, res) => {
      const input = z.object({ approve: z.boolean() }).strict().parse(req.body);
      await runtime.decide(
        req.params.projectId,
        req.params.approvalId,
        input.approve,
      );
      res.json({ resolved: true });
    },
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
        return;
      }
      const status = error instanceof AppError ? error.status : 500;
      // Unexpected failures are logged locally, redacted like every public message.
      if (status >= 500)
        console.error("Orbit request failed:", publicError(error));
      res.status(status).json({ error: publicError(error) });
    },
  );
  return { app, server, io };
}
