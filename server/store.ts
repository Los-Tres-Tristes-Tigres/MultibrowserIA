import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  BrowserAgentRecord,
  ObservableLogEvent,
  OrbitEvent,
  ProjectState,
  ProjectSummary,
  ProviderConfig,
} from "../shared/types.js";
import { AppError, idSchema, publicError } from "./validation.js";

const now = () => new Date().toISOString();
async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

export class WorkspaceStore extends EventEmitter {
  readonly root: string;
  private projects = new Map<string, ProjectState>();
  private queues = new Map<string, Promise<void>>();
  constructor(
    root = process.env.ORBIT_WORKSPACES_DIR ||
      path.join(os.homedir(), "Orbit Workspaces"),
  ) {
    super();
    this.root = path.resolve(root);
  }
  projectPath(id: string) {
    return path.join(this.root, idSchema.parse(id));
  }
  agentPath(projectId: string, agentId: string) {
    return path.join(
      this.projectPath(projectId),
      "agents",
      idSchema.parse(agentId),
    );
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !idSchema.safeParse(entry.name).success
      )
        continue;
      const file = path.join(this.root, entry.name, "project.json");
      try {
        const data = JSON.parse(
          await fs.readFile(file, "utf8"),
        ) as ProjectState;
        if (
          data.version !== 1 ||
          data.id !== entry.name ||
          !Array.isArray(data.agents)
        )
          throw new Error("Unsupported project format");
        const records: BrowserAgentRecord[] = [];
        for (const config of data.agents) {
          const state = JSON.parse(
            await fs.readFile(
              path.join(this.agentPath(data.id, config.id), "state.json"),
              "utf8",
            ),
          );
          const record = {
            ...state,
            ...config,
            browserOpen: false,
          } as BrowserAgentRecord;
          if (record.activeRunId) {
            record.status = "Idle";
            record.currentAction =
              "Previous run interrupted. Start a new task.";
            delete record.activeRunId;
            delete record.waitingForReply;
          }
          records.push(record);
        }
        data.agents = records;
        data.runs.forEach((run) => {
          if (run.status === "running" || run.status === "waiting") {
            run.status = "interrupted";
            run.error =
              "Application restarted. No pending action was replayed.";
            run.finishedAt = now();
          }
        });
        data.approvals.forEach((a) => {
          if (a.status === "pending" || a.status === "approved") {
            a.status = "expired";
            a.resolvedAt = now();
          }
        });
        this.projects.set(data.id, data);
        await this.save(data.id);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          !(await fs.stat(file).catch(() => null))
        )
          continue;
        throw new AppError(
          `Could not restore workspace ${entry.name}: ${publicError(error)}. Existing files were preserved.`,
          500,
        );
      }
    }
  }
  list(): ProjectSummary[] {
    return [...this.projects.values()].map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      agentCount: p.agents.length,
    }));
  }
  get(id: string) {
    const p = this.projects.get(id);
    if (!p) throw new AppError("Workspace not found.", 404);
    return p;
  }
  agent(projectId: string, agentId: string) {
    const agent = this.get(projectId).agents.find((a) => a.id === agentId);
    if (!agent) throw new AppError("Agent not found.", 404);
    return agent;
  }
  async create(
    name: string,
    starter = false,
    provider: ProviderConfig = { provider: "openai", model: "gpt-4.1" },
  ) {
    const slug =
      name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || "workspace";
    const id = `${slug}-${randomUUID().slice(0, 8)}`;
    const project: ProjectState = {
      version: 1,
      id,
      name,
      createdAt: now(),
      updatedAt: now(),
      agents: [],
      connections: [],
      workflows: [],
      viewport: { x: 30, y: 160, zoom: 1 },
      logs: [],
      runs: [],
      approvals: [],
      messages: [],
    };
    this.projects.set(id, project);
    await fs.mkdir(path.join(this.projectPath(id), "agents"), {
      recursive: true,
    });
    await fs.mkdir(path.join(this.projectPath(id), "workflows"), {
      recursive: true,
    });
    if (starter) {
      const gmail = await this.addAgent(id, {
        name: "Gmail",
        url: "https://mail.google.com/",
        preset: "gmail",
        provider,
        instructions: "",
        position: { x: 0, y: 0 },
      });
      const calendar = await this.addAgent(id, {
        name: "Calendar",
        url: "https://calendar.google.com/",
        preset: "calendar",
        provider,
        instructions: "",
        position: { x: 480, y: 0 },
      });
      project.connections.push({
        id: randomUUID(),
        source: gmail.id,
        target: calendar.id,
        instruction:
          "Use the meeting request to check availability and create the event in this calendar, after approval. If the time, timezone, duration or attendees are ambiguous, ask the user.",
      });
      project.workflows.push({
        id: randomUUID(),
        name: "Hackathon scheduling",
        startAgentId: gmail.id,
        instruction:
          "Busca un correo donde alguien me esté solicitando una reunión. Extrae la fecha, zona horaria, duración, asistentes y asunto, usando fechas absolutas cuando estén claras. Entrega la información al Calendar Agent para comprobar disponibilidad y crear el evento tras mi aprobación.",
      });
    }
    await this.save(id);
    return project;
  }
  async addAgent(
    projectId: string,
    input: {
      name: string;
      url: string;
      preset: string;
      provider: ProviderConfig;
      instructions: string;
      position?: { x: number; y: number };
    },
  ) {
    const project = this.get(projectId);
    const id = randomUUID();
    const agent: BrowserAgentRecord = {
      ...input,
      id,
      position: input.position || {
        x: 30 + project.agents.length * 80,
        y: 40 + project.agents.length * 60,
      },
      status: "Idle",
      currentAction: "Open browser to get started",
      currentUrl: input.url,
      pageTitle: "",
      browserOpen: false,
      chatHistory: [],
      logs: [],
      artifacts: [],
      createdAt: now(),
    };
    for (const dir of ["browser-profile", "downloads", "artifacts", "logs"])
      await fs.mkdir(path.join(this.agentPath(projectId, id), dir), {
        recursive: true,
      });
    project.agents.push(agent);
    await this.save(projectId);
    return agent;
  }
  async removeAgent(projectId: string, agentId: string) {
    const p = this.get(projectId);
    this.agent(projectId, agentId);
    const target = this.agentPath(projectId, agentId);
    // Resolve exactly one known agent directory; never use a caller-provided path.
    for (const dir of [
      this.projectPath(projectId),
      path.dirname(target),
      target,
    ]) {
      if ((await fs.lstat(dir)).isSymbolicLink())
        throw new AppError("Refusing to delete a linked directory.");
    }
    await this.flush(projectId);
    p.agents = p.agents.filter((a) => a.id !== agentId);
    p.connections = p.connections.filter(
      (e) => e.source !== agentId && e.target !== agentId,
    );
    p.workflows = p.workflows.filter((w) => w.startAgentId !== agentId);
    p.approvals = p.approvals.filter((a) => a.agentId !== agentId);
    // Save the removal before deleting profile data, so restart never loads a missing agent.
    await this.save(projectId);
    await fs.rm(target, { recursive: true });
  }
  changed(
    projectId: string,
    type: OrbitEvent["type"] = "state",
    agentId?: string,
    edgeId?: string,
  ) {
    this.emit("event", {
      projectId,
      type,
      agentId,
      edgeId,
    } satisfies OrbitEvent);
  }
  async save(projectId: string) {
    const p = this.get(projectId);
    p.updatedAt = now();
    const snapshot = structuredClone(p);
    const before = this.queues.get(projectId) || Promise.resolve();
    const write = before
      .catch(() => {})
      .then(async () => {
        for (const agent of snapshot.agents)
          await atomicJson(
            path.join(this.agentPath(projectId, agent.id), "state.json"),
            agent,
          );
        const agents = snapshot.agents.map(
          ({
            id,
            name,
            url,
            preset,
            provider,
            position,
            instructions,
            createdAt,
          }) => ({
            id,
            name,
            url,
            preset,
            provider,
            position,
            instructions,
            createdAt,
          }),
        );
        await atomicJson(
          path.join(this.projectPath(projectId), "project.json"),
          { ...snapshot, agents },
        );
        await atomicJson(
          path.join(
            this.projectPath(projectId),
            "workflows",
            "definitions.json",
          ),
          snapshot.workflows,
        );
      });
    this.queues.set(projectId, write);
    await write;
    this.changed(projectId);
  }
  async log(
    projectId: string,
    message: string,
    agentId?: string,
    runId?: string,
    level: ObservableLogEvent["level"] = "info",
  ) {
    const p = this.get(projectId);
    const event: ObservableLogEvent = {
      id: randomUUID(),
      timestamp: now(),
      message: publicError(new Error(message)),
      agentId,
      runId,
      level,
    };
    p.logs.push(event);
    p.logs = p.logs.slice(-500);
    if (agentId) {
      const a = this.agent(projectId, agentId);
      a.logs.push(event);
      a.logs = a.logs.slice(-500);
      await fs.appendFile(
        path.join(this.agentPath(projectId, agentId), "logs", "events.jsonl"),
        JSON.stringify(event) + "\n",
        { mode: 0o600 },
      );
    }
    await fs.appendFile(
      path.join(this.projectPath(projectId), "events.jsonl"),
      JSON.stringify(event) + "\n",
      { mode: 0o600 },
    );
    await this.save(projectId);
    this.changed(projectId, "log", agentId);
    return event;
  }
  async flush(id?: string) {
    if (id) await this.queues.get(id);
    else await Promise.all([...this.queues.values()]);
  }
}
