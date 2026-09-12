import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  AppWindow,
  MessageSquare,
  FileText,
  MoreHorizontal,
  ExternalLink,
  LockKeyhole,
  Send,
  Square,
  Download,
  ArrowDownLeft,
} from "lucide-react";
import type { BrowserAgentRecord } from "../../shared/types";
import { AppIcon } from "./Icons";
import { agentUrl } from "../api";

export type AgentNodeData = {
  agent: BrowserAgentRecord;
  projectId: string;
  previewVersion: number;
  selectedTab?: string;
  onBrowser(id: string): void;
  onSettings(id: string): void;
  onChat(id: string, text: string): Promise<void>;
  onStop(id: string): void;
} & Record<string, unknown>;
export type FlowAgentNode = Node<AgentNodeData, "browserAgent">;
export const statusClass = (status: string) =>
  status.toLowerCase().replace(/\s+/g, "-");
export const AgentNode = memo(function AgentNode({
  data,
  selected,
}: NodeProps<FlowAgentNode>) {
  const { agent, projectId } = data;
  const [tab, setTab] = useState("Browser");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [imageError, setImageError] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data.selectedTab) setTab(data.selectedTab);
  }, [data.selectedTab]);
  useEffect(() => {
    history.current?.scrollTo({ top: history.current.scrollHeight });
  }, [agent.chatHistory.length, tab]);
  useEffect(
    () => setImageError(false),
    [data.previewVersion, agent.browserOpen],
  );
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await data.onChat(agent.id, text.trim());
      setText("");
    } catch {
      /* Parent displays error. */
    } finally {
      setSending(false);
    }
  };
  const active = Boolean(agent.activeRunId);
  const canSend = !active || agent.waitingForReply;
  const url = (() => {
    try {
      return new URL(agent.currentUrl || agent.url).hostname;
    } catch {
      return agent.url;
    }
  })();
  return (
    <article
      className={`agent-node ${selected ? "is-selected" : ""} state-${statusClass(agent.status)}`}
      aria-label={`${agent.name} Browser Agent`}
    >
      <Handle
        type="target"
        position={Position.Left}
        aria-label={`Connect to ${agent.name}`}
      />
      <header className="node-header drag-handle">
        <AppIcon preset={agent.preset} size={30} />
        <h2>{agent.name}</h2>
        <span
          className={`status-dot ${statusClass(agent.status)}`}
          title={agent.status}
        />
        <button
          className="icon-button nodrag"
          title={`Settings for ${agent.name}`}
          aria-label={`Settings for ${agent.name}`}
          onClick={() => data.onSettings(agent.id)}
        >
          <MoreHorizontal size={21} />
        </button>
      </header>
      <div className="address-bar nodrag">
        <LockKeyhole size={13} />
        <span title={agent.currentUrl}>{url}</span>
        <button
          className="icon-button"
          title="Open Browser"
          aria-label={`Open ${agent.name} browser`}
          onClick={() => data.onBrowser(agent.id)}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div className="node-content nodrag nowheel">
        {tab === "Browser" && (
          <div className="browser-preview">
            {agent.browserOpen && !imageError ? (
              <>
                <img
                  draggable={false}
                  src={`/api${agentUrl(projectId, agent.id)}/preview?t=${data.previewVersion}`}
                  alt={`${agent.name} live browser preview`}
                  onError={() => setImageError(true)}
                />
                <span className="preview-live">
                  <span /> LIVE
                </span>
              </>
            ) : (
              <div className="preview-empty">
                <div className="empty-window">
                  <AppIcon preset={agent.preset} size={39} />
                </div>
                <h3>
                  {agent.browserOpen
                    ? "Connecting to browser"
                    : "Your browser, your session"}
                </h3>
                <p>
                  {agent.browserOpen
                    ? "The next preview will appear here."
                    : `Open ${agent.name} and sign in to get started.`}
                </p>
                <button
                  className="button small"
                  onClick={() => data.onBrowser(agent.id)}
                >
                  <ExternalLink size={14} />
                  Open Browser
                </button>
              </div>
            )}
          </div>
        )}
        {tab === "Chat" && (
          <div className="node-chat">
            <div className="chat-history" ref={history}>
              {!agent.chatHistory.length && (
                <div className="chat-empty">
                  <MessageSquare size={26} />
                  <h3>Talk to {agent.name}</h3>
                  <p>
                    Give this browser a task.
                    <br />
                    You stay in control of every important action.
                  </p>
                </div>
              )}
              {agent.chatHistory.map((message) => (
                <div
                  className={`chat-message ${message.role}`}
                  key={message.id}
                >
                  <label>
                    {message.role === "user" ? (
                      "You"
                    ) : message.role === "handoff" ? (
                      <>
                        <ArrowDownLeft size={12} /> Incoming context
                      </>
                    ) : (
                      agent.name
                    )}
                  </label>
                  <div>{message.text}</div>
                </div>
              ))}
            </div>
            <form onSubmit={send} className="chat-input">
              <input
                aria-label={`Ask ${agent.name} Agent`}
                placeholder={
                  active && agent.waitingForReply
                    ? "Reply to continue…"
                    : `Ask ${agent.name} Agent…`
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!canSend}
              />
              <button
                className="icon-button"
                disabled={!text.trim() || sending || !canSend}
                aria-label={`Send to ${agent.name}`}
              >
                <Send size={16} />
              </button>
            </form>
          </div>
        )}
        {tab === "Logs" && (
          <div className="node-logs">
            <div className="log-heading">BROWSER ACTIVITY</div>
            {!agent.logs.length && (
              <p className="muted">
                Actions will appear here when this agent starts.
              </p>
            )}
            {agent.logs.slice(-30).map((log) => (
              <div className={`log-row ${log.level}`} key={log.id}>
                <time>
                  {new Date(log.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span>{log.message}</span>
              </div>
            ))}
            {agent.artifacts.length > 0 && (
              <>
                <div className="log-heading artifact-heading">ARTIFACTS</div>
                {agent.artifacts.map((a) => (
                  <a
                    className="artifact"
                    key={a.id}
                    href={`/api${agentUrl(projectId, agent.id)}/artifacts/${a.id}`}
                  >
                    <Download size={13} />
                    {a.name}
                  </a>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <div className="node-status">
        <span className={`status-badge ${statusClass(agent.status)}`}>
          <span className={`status-dot ${statusClass(agent.status)}`} />
          {agent.status}
        </span>
        <span
          className="provider-mini"
          title={`${agent.provider.provider} · ${agent.provider.model}`}
        >
          {agent.provider.provider === "gemini"
            ? "Gemini"
            : agent.provider.provider === "openai"
              ? "OpenAI"
              : "OpenRouter"}
        </span>
        <p title={agent.currentAction}>{agent.currentAction}</p>
      </div>
      <footer className="node-tabs nodrag">
        {[
          { name: "Chat", Icon: MessageSquare },
          { name: "Browser", Icon: AppWindow },
          { name: "Logs", Icon: FileText },
        ].map(({ name, Icon }) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={name === tab ? "active" : ""}
          >
            <Icon size={17} />
            {name}
          </button>
        ))}
        {active && (
          <button
            className="stop-button"
            onClick={() => data.onStop(agent.activeRunId!)}
            aria-label={`Stop ${agent.name}`}
            title="Stop task"
          >
            <Square size={13} />
          </button>
        )}
      </footer>
      <Handle
        type="source"
        position={Position.Right}
        aria-label={`Connect from ${agent.name}`}
      />
    </article>
  );
});
