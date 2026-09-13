import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentMessage,
  AgentResult,
  AgentStatus,
  ApprovalRequest,
  BrowserAgentRecord,
  WorkflowRun,
} from "../shared/types.js";
import { BrowserManager } from "./browser.js";
import { WorkspaceStore } from "./store.js";
import {
  assertProvider,
  createPlanner,
  type AgentStep,
  type Planner,
} from "./providers.js";
import { AppError, linearPath, publicError } from "./validation.js";
import { formatHits, postToSlack, research, searchWeb } from "./tigre.js";
import {
  fingerprint,
  navigationNeedsApproval,
  requiresApproval,
} from "./policy.js";

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
  reply?: (text: string) => void;
}
interface DecisionWaiter {
  projectId: string;
  runId: string;
  resolve: (approved: boolean) => void;
}
const timestamp = () => new Date().toISOString();
const jsonObject = (value: string): Record<string, unknown> => {
  const result = JSON.parse(value);
  if (!result || Array.isArray(result) || typeof result !== "object")
    throw new AppError("The model returned invalid structured data.");
  return result;
};

export class AgentRuntime {
  private active = new Map<string, ActiveRun>();
  private decisions = new Map<string, DecisionWaiter>();
  constructor(
    readonly store: WorkspaceStore,
    readonly browsers: BrowserManager,
    private dependencies: {
      planner?: (agent: BrowserAgentRecord) => Planner;
      checkProvider?: (config: BrowserAgentRecord["provider"]) => void;
      maxSteps?: number;
      postToSlack?: typeof postToSlack;
    } = {},
  ) {
    store.on(
      "browserClosed",
      ({ projectId, agentId }: { projectId: string; agentId: string }) => {
        const id = store.agent(projectId, agentId).activeRunId;
        if (id)
          this.cancel(
            projectId,
            id,
            "Browser closed. Run stopped; no pending actions will be replayed.",
          );
      },
    );
  }
  async start(
    projectId: string,
    agentId: string,
    instruction: string,
    workflowId?: string,
  ) {
    const p = this.store.get(projectId);
    const agentIds = workflowId
      ? linearPath(p.agents, p.connections, agentId)
      : [agentId];
    for (const id of agentIds) {
      const a = this.store.agent(projectId, id);
      if (a.activeRunId)
        throw new AppError(`${a.name} already has an active task.`, 409);
      (this.dependencies.checkProvider || assertProvider)(a.provider);
    }
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId,
      instruction,
      agentIds,
      currentAgentId: agentId,
      status: "running",
      createdAt: timestamp(),
    };
    p.runs.push(run);
    for (const id of agentIds) {
      const a = this.store.agent(projectId, id);
      a.activeRunId = run.id;
      a.status = id === agentId ? "Thinking" : "Waiting";
      a.currentAction =
        id === agentId ? "Starting task" : "Waiting for incoming context";
    }
    const active: ActiveRun = {
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(run.id, active);
    try {
      await this.store.save(projectId);
    } catch (error) {
      this.active.delete(run.id);
      for (const id of agentIds)
        delete this.store.agent(projectId, id).activeRunId;
      throw error;
    }
    active.done = this.executeWorkflow(projectId, run, active).finally(() =>
      this.active.delete(run.id),
    );
    // Handle errors without logging provider internals or leaving an unhandled rejection.
    void active.done.catch((error) =>
      console.error("Run cleanup failed:", publicError(error)),
    );
    return run;
  }
  private check(signal: AbortSignal) {
    if (signal.aborted) throw new AppError("Task cancelled.", 409);
  }
  private async status(
    projectId: string,
    agent: BrowserAgentRecord,
    status: AgentStatus,
    message: string,
  ) {
    agent.status = status;
    agent.currentAction = message;
    await this.store.save(projectId);
  }
  private chat(
    agent: BrowserAgentRecord,
    role: "user" | "assistant" | "handoff",
    text: string,
    runId: string,
  ) {
    agent.chatHistory.push({
      id: randomUUID(),
      role,
      text,
      runId,
      timestamp: timestamp(),
    });
  }
  private async executeWorkflow(
    projectId: string,
    run: WorkflowRun,
    active: ActiveRun,
  ) {
    let incoming: AgentMessage | undefined;
    const p = this.store.get(projectId);
    try {
      for (let index = 0; index < run.agentIds.length; index++) {
        this.check(active.controller.signal);
        const agent = this.store.agent(projectId, run.agentIds[index]);
        run.currentAgentId = agent.id;
        const result = await this.executeAgent(
          projectId,
          agent,
          run,
          active,
          incoming,
          index < run.agentIds.length - 1,
        );
        this.check(active.controller.signal);
        const target = run.agentIds[index + 1];
        if (target) {
          const edge = p.connections.find(
            (e) => e.source === agent.id && e.target === target,
          );
          if (!edge) throw new AppError("Workflow connection was removed.");
          incoming = {
            id: randomUUID(),
            runId: run.id,
            sourceAgentId: agent.id,
            targetAgentId: target,
            type: result.type,
            instruction:
              edge.instruction ||
              "Continue the user’s task using this result in your own browser. Ask for any missing information.",
            data: result.data,
            summary: result.summary,
            timestamp: timestamp(),
          };
          p.messages.push(incoming);
          this.chat(
            this.store.agent(projectId, target),
            "handoff",
            `Context from ${agent.name}: ${result.summary}\n${JSON.stringify(result.data, null, 2)}`,
            run.id,
          );
          await this.store.log(
            projectId,
            `Sent context → ${this.store.agent(projectId, target).name}`,
            agent.id,
            run.id,
            "success",
          );
          this.store.changed(projectId, "handoff", target, edge.id);
        }
      }
      run.status = "completed";
      run.finishedAt = timestamp();
      await this.store.log(
        projectId,
        "Workflow completed",
        undefined,
        run.id,
        "success",
      );
    } catch (error) {
      const agent = this.store.agent(projectId, run.currentAgentId);
      const cancelled = active.controller.signal.aborted;
      run.status = cancelled ? "cancelled" : "error";
      run.error = cancelled
        ? run.error || "Task cancelled."
        : publicError(error);
      run.finishedAt = timestamp();
      agent.status = cancelled ? "Idle" : "Error";
      agent.currentAction = run.error;
      this.chat(agent, "assistant", run.error, run.id);
      await this.store.log(
        projectId,
        run.error,
        agent.id,
        run.id,
        cancelled ? "info" : "error",
      );
    } finally {
      for (const id of run.agentIds) {
        const a = this.store.agent(projectId, id);
        delete a.activeRunId;
        delete a.waitingForReply;
        if (
          [
            "Thinking",
            "Navigating",
            "Typing",
            "Reading",
            "Waiting",
            "Needs Approval",
          ].includes(a.status)
        ) {
          a.status = "Idle";
          a.currentAction = "Task stopped";
        }
      }
      p.approvals
        .filter((a) => a.runId === run.id && a.status === "pending")
        .forEach((a) => {
          a.status = "expired";
          a.resolvedAt = timestamp();
        });
      await this.store.save(projectId);
    }
  }
  private async executeAgent(
    projectId: string,
    agent: BrowserAgentRecord,
    run: WorkflowRun,
    active: ActiveRun,
    incoming: AgentMessage | undefined,
    hasNext: boolean,
  ): Promise<AgentResult> {
    const signal = active.controller.signal;
    const planner =
      this.dependencies.planner?.(agent) || createPlanner(agent.provider);
    const task = incoming ? incoming.instruction : run.instruction;
    this.chat(agent, "user", task, run.id);
    await this.status(projectId, agent, "Navigating", "Opening browser");
    await this.browsers.open(projectId, agent.id);
    this.check(signal);
    await this.store.log(projectId, `${agent.name} started`, agent.id, run.id);
    const observations: string[] = [];
    const configured = Number(process.env.ORBIT_MAX_STEPS || 30);
    const maxSteps =
      this.dependencies.maxSteps ||
      Math.min(100, Math.max(1, Number.isFinite(configured) ? configured : 30));
    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      this.check(signal);
      await this.status(projectId, agent, "Reading", "Reading current page");
      const pageText = await this.browsers.read(projectId, agent.id);
      this.check(signal);
      await this.status(
        projectId,
        agent,
        "Thinking",
        `Choosing action · step ${stepNumber}/${maxSteps}`,
      );
      const context = JSON.stringify({
        permanentContext: agent.instructions || "",
        agent: {
          name: agent.name,
          initialUrl: agent.url,
          preset: agent.preset,
          instructions: agent.instructions,
        },
        slackAssist:
          agent.preset === "slack"
            ? {
                lastChannel: agent.lastChannel || null,
                lastThread: agent.lastThread || null,
                tools: ["search_web", "ask_tigre", "post_to_slack"],
              }
            : null,
        currentTime: timestamp(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        task: incoming ? incoming.instruction : run.instruction,
        overallWorkflowGoal: run.instruction,
        handoffRole: hasNext
          ? "Produce relevant structured information for the next connected agent. Do not operate the next agent’s website."
          : "Complete the task in your own browser. Verify every external action after approval.",
        explicitlyTransferredContext: incoming || null,
        ownChat: agent.chatHistory
          .slice(-18)
          .map((m) => ({ role: m.role, text: m.text })),
        observableResults: observations.slice(-18),
      });
      let step: AgentStep;
      try {
        step = await planner.next({ context, pageText, signal });
      } catch (error) {
        const message = publicError(error);
        step = {
          kind: "finish",
          instruction: "Recovered after planner failure",
          url: null,
          impact: "read",
          summary: /object generated|parse the response/i.test(message)
            ? "El modelo no devolvió un paso válido. Pregunta una sola cosa: o la web, o esta pestaña, o publicar. No las tres juntas."
            : message,
          data: "{}",
        };
      }
      this.check(signal);
      if (step.kind === "finish") {
        const result: AgentResult = {
          type: "browser_result",
          summary: step.summary,
          data: jsonObject(step.data),
          sourceUrl: agent.currentUrl,
        };
        agent.lastResult = result;
        this.chat(agent, "assistant", result.summary, run.id);
        const artifactId = randomUUID();
        const relativePath = path.join("artifacts", `${artifactId}.json`);
        await fs.writeFile(
          path.join(this.store.agentPath(projectId, agent.id), relativePath),
          JSON.stringify(result, null, 2),
          { mode: 0o600 },
        );
        agent.artifacts.push({
          id: artifactId,
          name: `Result · ${new Date().toLocaleTimeString()}.json`,
          kind: "result",
          relativePath,
          createdAt: timestamp(),
        });
        await this.status(projectId, agent, "Completed", result.summary);
        await this.store.log(
          projectId,
          result.summary,
          agent.id,
          run.id,
          "success",
        );
        return result;
      }
      if (step.kind === "ask") {
        this.chat(agent, "assistant", step.summary || step.instruction, run.id);
        run.status = "waiting";
        agent.waitingForReply = true;
        const response = new Promise<string>((resolve, reject) => {
          const abort = () => {
            active.reply = undefined;
            reject(new AppError("Task cancelled."));
          };
          signal.addEventListener("abort", abort, { once: true });
          active.reply = (text) => {
            signal.removeEventListener("abort", abort);
            active.reply = undefined;
            resolve(text);
          };
          if (signal.aborted) abort();
        });
        void response.catch(() => {});
        await this.status(
          projectId,
          agent,
          "Waiting",
          step.summary || step.instruction,
        );
        const reply = await response;
        this.check(signal);
        agent.waitingForReply = false;
        run.status = "running";
        observations.push(`User clarification: ${reply}`);
        continue;
      }
      if (step.kind === "wait") {
        await this.status(projectId, agent, "Waiting", step.summary);
        await delay(1500, undefined, { signal });
        continue;
      }
      if (
        step.kind === "search_web" ||
        step.kind === "ask_tigre" ||
        step.kind === "post_to_slack"
      ) {
        await this.status(projectId, agent, "Reading", step.summary);
        if (step.kind === "search_web") {
          const hits = await searchWeb(step.instruction);
          const formatted = formatHits(hits);
          observations.push(`search_web: ${formatted}`);
          await this.store.log(
            projectId,
            `Exa search: ${step.instruction}`,
            agent.id,
            run.id,
          );
        } else if (step.kind === "ask_tigre") {
          const answer = await research(
            step.instruction,
            [
              agent.lastChannel ? `channel ${agent.lastChannel}` : "",
              agent.lastThread ? `thread ${agent.lastThread}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          );
          observations.push(`ask_tigre: ${answer}`);
          this.chat(agent, "assistant", answer, run.id);
          await this.store.log(
            projectId,
            `Tigre: ${step.instruction}`,
            agent.id,
            run.id,
            "success",
          );
        } else {
          const channel =
            step.url ||
            agent.lastChannel ||
            (step.instruction.match(/#[\w-]+/) || [])[0];
          if (!channel)
            throw new AppError(
              "post_to_slack needs a channel like #informal in url.",
            );
          const text = (step.instruction || step.summary).trim();
          if (!text)
            throw new AppError("post_to_slack needs a message to send.");
          const action = {
            method: "post_to_slack" as const,
            channel,
            text,
            ...(agent.lastThread ? { threadTs: agent.lastThread } : {}),
          };
          const hash = createHash("sha256")
            .update(JSON.stringify(action))
            .digest("hex");
          await this.approve(
            projectId,
            agent,
            run,
            action,
            hash,
            `Post to ${channel}`,
            `Channel: ${channel}\nMessage:\n${text}`,
            signal,
          );
          this.check(signal);
          const posted = await (this.dependencies.postToSlack || postToSlack)(
            channel,
            text,
            agent.lastThread,
          );
          agent.lastChannel = channel;
          agent.lastThread = posted.ts;
          observations.push(
            `Posted to Slack ${channel} (${posted.ts}): ${step.summary}`,
          );
          await this.store.log(
            projectId,
            `Posted to Slack ${channel}`,
            agent.id,
            run.id,
            "success",
          );
        }
        await this.store.save(projectId);
        continue;
      }
      if (step.kind === "extract") {
        await this.status(projectId, agent, "Reading", step.summary);
        const extracted = await this.browsers.extract(
          projectId,
          agent.id,
          step.instruction,
        );
        this.check(signal);
        jsonObject(extracted.data);
        observations.push(`Extracted: ${JSON.stringify(extracted)}`);
        await this.store.log(
          projectId,
          `Extracted: ${extracted.summary}`,
          agent.id,
          run.id,
        );
        continue;
      }
      if (step.kind === "navigate") {
        if (!step.url) throw new AppError("Navigation requires a URL.");
        const url = this.browsers.validateUrl(step.url);
        if (navigationNeedsApproval(url, step.impact)) {
          const session = this.browsers.session(projectId, agent.id);
          const before =
            session.generation + this.browsers.currentPage(session).url();
          const hash = createHash("sha256").update(before).digest("hex");
          await this.approve(
            projectId,
            agent,
            run,
            { method: "goto", url },
            hash,
            step.summary,
            step.instruction,
            signal,
          );
          this.check(signal);
          if (
            before !==
            this.browsers.session(projectId, agent.id).generation +
              this.browsers
                .currentPage(this.browsers.session(projectId, agent.id))
                .url()
          )
            throw new AppError(
              "Browser changed while awaiting approval. No action was performed.",
            );
        }
        this.check(signal);
        await this.status(projectId, agent, "Navigating", step.summary);
        this.check(signal);
        await this.browsers.navigate(projectId, agent.id, url);
        this.check(signal);
      } else {
        const action = await this.browsers.resolve(
          projectId,
          agent.id,
          step.instruction,
        );
        this.check(signal);
        const evidence = await this.browsers.evidence(
          projectId,
          agent.id,
          action,
        );
        this.check(signal);
        if (evidence.href) this.browsers.validateUrl(evidence.href);
        const hash = fingerprint(evidence);
        if (requiresApproval(step, action, evidence)) {
          await this.browsers.capture(projectId, agent.id);
          this.check(signal);
          const values = action.arguments.length
            ? `\nValue: ${action.arguments.join(", ")}`
            : "";
          await this.approve(
            projectId,
            agent,
            run,
            action,
            hash,
            step.summary,
            `${step.instruction}${values}\nPage: ${evidence.url}\nTarget: ${evidence.label || evidence.text || action.description}\nForm: ${evidence.formState.slice(0, 6000)}`,
            signal,
          );
          this.check(signal);
          const fresh = await this.browsers.evidence(
            projectId,
            agent.id,
            action,
          );
          this.check(signal);
          if (fingerprint(fresh) !== hash)
            throw new AppError(
              "Page or form changed while awaiting approval. Action was not executed. Start a fresh task to review the updated action.",
            );
        }
        await this.status(
          projectId,
          agent,
          ["fill", "type", "press"].includes(action.method)
            ? "Typing"
            : "Navigating",
          step.summary,
        );
        this.check(signal);
        await this.browsers.execute(projectId, agent.id, action);
        this.check(signal);
      }
      observations.push(`Executed: ${step.summary}`);
      await this.store.log(projectId, step.summary, agent.id, run.id);
    }
    throw new AppError(
      `Reached ${maxSteps} steps. Review the current page and continue with a new instruction.`,
    );
  }
  private async approve(
    projectId: string,
    agent: BrowserAgentRecord,
    run: WorkflowRun,
    action: ApprovalRequest["action"],
    hash: string,
    title: string,
    description: string,
    signal: AbortSignal,
  ) {
    const request: ApprovalRequest = {
      id: randomUUID(),
      agentId: agent.id,
      runId: run.id,
      title,
      description,
      url: agent.currentUrl,
      action: structuredClone(action),
      fingerprint: hash,
      status: "pending",
      createdAt: timestamp(),
    };
    this.store.get(projectId).approvals.push(request);
    run.status = "waiting";
    // Install the waiter before broadcasting the request, so an immediate click cannot race it.
    const choice = new Promise<boolean>((resolve, reject) => {
      const abort = () => {
        this.decisions.delete(request.id);
        request.status = "expired";
        request.resolvedAt = timestamp();
        reject(new AppError("Task cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.decisions.set(request.id, {
        projectId,
        runId: run.id,
        resolve: (approved) => {
          signal.removeEventListener("abort", abort);
          this.decisions.delete(request.id);
          resolve(approved);
        },
      });
      if (signal.aborted) abort();
    });
    // Attach the handler immediately, even if cancellation arrives during persistence.
    void choice.catch(() => {});
    await this.status(projectId, agent, "Needs Approval", title);
    this.store.changed(projectId, "approval", agent.id);
    await this.store.log(
      projectId,
      `Needs approval: ${title}`,
      agent.id,
      run.id,
    );
    const approved = await choice;
    if (!approved) {
      this.cancel(
        projectId,
        run.id,
        "Action rejected. No action was performed.",
      );
      throw new AppError("Action rejected.");
    }
    this.check(signal);
    run.status = "running";
  }
  async decide(projectId: string, approvalId: string, approve: boolean) {
    const p = this.store.get(projectId);
    const request = p.approvals.find((a) => a.id === approvalId);
    const waiter = this.decisions.get(approvalId);
    if (
      !request ||
      request.status !== "pending" ||
      !waiter ||
      waiter.projectId !== projectId
    )
      throw new AppError(
        "This approval has already been resolved or expired.",
        409,
      );
    request.status = approve ? "approved" : "rejected";
    request.resolvedAt = timestamp();
    await this.store.log(
      projectId,
      `${approve ? "Approved" : "Rejected"}: ${request.title}`,
      request.agentId,
      request.runId,
    );
    waiter.resolve(approve);
  }
  async reply(projectId: string, agentId: string, text: string) {
    const agent = this.store.agent(projectId, agentId);
    const id = agent.activeRunId;
    const active = id && this.active.get(id);
    if (!active || !active.reply)
      throw new AppError("This agent is not waiting for a reply.", 409);
    const resolve = active.reply;
    active.reply = undefined;
    agent.waitingForReply = false;
    this.chat(agent, "user", text, id!);
    await this.store.save(projectId);
    resolve(text);
  }
  cancel(projectId: string, runId: string, reason = "Task cancelled by user.") {
    const run = this.store.get(projectId).runs.find((r) => r.id === runId);
    if (!run) throw new AppError("Run not found.", 404);
    const active = this.active.get(runId);
    if (active) {
      run.error = reason;
      active.controller.abort();
    }
  }
  async wait(runId: string) {
    await this.active.get(runId)?.done;
  }
  async shutdown() {
    for (const p of this.store.list())
      for (const r of this.store.get(p.id).runs)
        if (this.active.has(r.id))
          this.cancel(p.id, r.id, "Application stopped.");
    await this.browsers.closeAll();
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
