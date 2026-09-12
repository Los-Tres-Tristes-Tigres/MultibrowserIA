import { useState } from "react";
import {
  ArrowRight,
  Check,
  Folder,
  Plus,
  Play,
  Trash2,
  Users,
} from "lucide-react";
import type {
  AppSnapshot,
  BrowserAgentRecord,
  ProviderConfig,
  Workflow,
} from "../../shared/types";
import { PRESETS, PROVIDERS } from "../../shared/presets";
import { api, agentUrl } from "../api";
import { Modal } from "./Modal";
import { AppIcon } from "./Icons";

function useFormAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
export function AgentForm({
  snapshot,
  agent,
  close,
  saved,
}: {
  snapshot: AppSnapshot;
  agent?: BrowserAgentRecord;
  close(): void;
  saved(): Promise<void>;
}) {
  const [preset, setPreset] = useState(agent?.preset || "gmail");
  const [name, setName] = useState(agent?.name || "Gmail");
  const [url, setUrl] = useState(agent?.url || "https://mail.google.com/");
  const initialProvider =
    snapshot.providers.find((p) => p.available) || snapshot.providers[0];
  const [provider, setProvider] = useState<ProviderConfig>(
    agent?.provider || {
      provider: initialProvider.id,
      model: initialProvider.defaultModel,
    },
  );
  const [instructions, setInstructions] = useState(agent?.instructions || "");
  const [browserSession, setBrowserSession] = useState(
    agent?.browserSession || snapshot.browser.defaultSession,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, submit } = useFormAction();
  const available = snapshot.providers.find((p) => p.id === provider.provider);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void submit(async () => {
      await api(
        agent
          ? agentUrl(snapshot.project.id, agent.id)
          : `/projects/${snapshot.project.id}/agents`,
        agent ? "PATCH" : "POST",
        { name, url, preset, provider, browserSession, instructions },
      );
      await saved();
      close();
    });
  };
  return (
    <Modal
      title={agent ? `${agent.name} settings` : "Add Browser Agent"}
      close={close}
    >
      <form onSubmit={save} className="stack-form">
        {!agent && (
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`preset-choice ${p.id === preset ? "active" : ""}`}
                onClick={() => {
                  setPreset(p.id);
                  setName(p.id === "custom" ? "" : p.name);
                  setUrl(p.url);
                }}
              >
                <AppIcon preset={p.id} size={25} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="form-row">
          <label>
            Name
            <input
              required
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="My website"
            />
          </label>
          <label>
            Website URL
            <input
              required
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
        </div>
        <label>
          Browser session
          <select
            value={browserSession}
            disabled={Boolean(agent?.browserOpen || agent?.activeRunId)}
            onChange={(e) =>
              setBrowserSession(e.target.value as "shared" | "isolated")
            }
          >
            <option
              value="shared"
              disabled={!snapshot.browser.sharedSessionAvailable}
            >
              Shared Orbit session
            </option>
            <option value="isolated">Independent profile</option>
          </select>
        </label>
        <p className="form-note session-note">
          {browserSession === "shared" ? (
            <>
              <Users size={14} /> Sign in once. Every shared agent and workspace
              uses the same Orbit Chrome account.
            </>
          ) : (
            <>
              <Folder size={14} /> This agent keeps a separate login and browser
              profile.
            </>
          )}
          {agent?.browserOpen && (
            <span>Close this browser before changing its session.</span>
          )}
          {!snapshot.browser.sharedSessionAvailable && (
            <span>Shared Chrome is disabled in Docker.</span>
          )}
        </p>
        <div className="form-divider" />
        <div className="form-row">
          <label>
            AI provider
            <select
              value={provider.provider}
              onChange={(e) => {
                const next = PROVIDERS.find((p) => p.id === e.target.value)!;
                setProvider({ provider: next.id, model: next.defaultModel });
              }}
            >
              {snapshot.providers.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                  {p.available ? "" : " · key missing"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input
              required
              list="provider-models"
              value={provider.model}
              onChange={(e) =>
                setProvider({ ...provider, model: e.target.value })
              }
              placeholder={available?.defaultModel}
            />
          </label>
          <datalist id="provider-models">
            {available?.models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
        <p
          className={`form-note ${available?.available ? "success-text" : ""}`}
        >
          {available?.available ? (
            <>
              <Check size={14} /> Provider key is configured.
            </>
          ) : (
            <>
              Add <code>{available?.envName}</code> to .env to run tasks. You
              can open the browser and log in now.
            </>
          )}
        </p>
        <label>
          Agent instructions <span className="optional">Optional</span>
          <textarea
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Give this browser context for future tasks…"
          />
        </label>
        {agent && browserSession === "isolated" && (
          <p className="form-note">
            <Folder size={14} />
            <span>
              Independent profile, chat and downloads.
              <br />
              <code>agents/{agent.id}/</code>
            </span>
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {confirmDelete && (
          <div className="delete-confirm">
            <strong>Delete {agent?.name} and all its data?</strong>
            <p>
              {agent?.browserSession === "shared"
                ? "This closes its tab and permanently deletes its chats, logs and downloads. The shared Chrome account stays signed in."
                : "This closes its browser and permanently deletes its login session, chats, logs and downloads."}
            </p>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() =>
                void submit(async () => {
                  await api(
                    agentUrl(snapshot.project.id, agent!.id),
                    "DELETE",
                    { confirm: true },
                  );
                  await saved();
                  close();
                })
              }
            >
              Delete permanently
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Keep agent
            </button>
          </div>
        )}
        <footer className="form-actions">
          {agent && (
            <button
              type="button"
              className="button ghost delete-trigger"
              disabled={Boolean(agent.activeRunId)}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} />
              Delete agent
            </button>
          )}
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || Boolean(agent?.activeRunId)}
          >
            {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
            {!agent && <Plus size={16} />}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ProjectForm({
  close,
  created,
}: {
  close(): void;
  created(id: string): void;
}) {
  const [name, setName] = useState("");
  const [starter, setStarter] = useState(false);
  const { busy, error, submit } = useFormAction();
  return (
    <Modal title="New workspace" close={close}>
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(async () => {
            const p = await api<{ id: string }>("/projects", "POST", {
              name,
              starter,
            });
            created(p.id);
            close();
          });
        }}
      >
        <p className="muted">
          A real folder for your browsers, conversations and workflows.
        </p>
        <label>
          Workspace name
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My workspace"
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={starter}
            onChange={(e) => setStarter(e.target.checked)}
          />
          Start with Gmail → Calendar
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Create workspace
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function WorkflowForm({
  snapshot,
  workflowId,
  close,
  saved,
}: {
  snapshot: AppSnapshot;
  workflowId?: string;
  close(): void;
  saved(): Promise<void>;
}) {
  const { project } = snapshot;
  const first =
    workflowId === "new"
      ? undefined
      : project.workflows.find((w) => w.id === workflowId) ||
        project.workflows[0];
  const [selected, setSelected] = useState(first?.id || "new");
  const [name, setName] = useState("My workflow");
  const [start, setStart] = useState(
    first?.startAgentId || project.agents[0]?.id || "",
  );
  const [task, setTask] = useState(first?.instruction || "");
  const { busy, error, submit } = useFormAction();
  const path: string[] = [];
  let next =
    selected === "new"
      ? start
      : project.workflows.find((w) => w.id === selected)?.startAgentId;
  while (next && !path.includes(next)) {
    path.push(next);
    next = project.connections.find((e) => e.source === next)?.target;
  }
  return (
    <Modal title="Run workflow" close={close}>
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(async () => {
            let id = selected;
            if (id === "new") {
              const w = await api<Workflow>(
                `/projects/${project.id}/workflows`,
                "POST",
                { name, startAgentId: start, instruction: task },
              );
              id = w.id;
              setSelected(id);
              await saved();
            }
            await api(`/projects/${project.id}/workflows/${id}/run`, "POST", {
              text: task,
            });
            await saved();
            close();
          });
        }}
      >
        <label>
          Workflow
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              const w = project.workflows.find((w) => w.id === e.target.value);
              if (w) {
                setTask(w.instruction);
                setStart(w.startAgentId);
              }
            }}
          >
            {project.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value="new">+ Create a workflow</option>
          </select>
        </label>
        {selected === "new" && (
          <div className="form-row">
            <label>
              Workflow name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Starting agent
              <select
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              >
                {project.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="workflow-path">
          {path.map((id, index) => {
            const a = project.agents.find((a) => a.id === id)!;
            return (
              <span key={id}>
                {index > 0 && <ArrowRight size={17} />}
                <AppIcon preset={a.preset} size={21} />
                {a.name}
              </span>
            );
          })}
        </div>
        <label>
          What should this workflow do?
          <textarea
            autoFocus
            required
            rows={5}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe the task. Each connected agent will continue using its own browser…"
          />
        </label>
        <p className="form-note">
          Results move through the connected browsers. Actions that change
          external data pause for your approval.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || !start} className="button primary">
            <Play size={16} fill="currentColor" />
            {busy ? "Starting…" : "Run workflow"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function SettingsDialog({
  snapshot,
  close,
}: {
  snapshot: AppSnapshot;
  close(): void;
}) {
  return (
    <Modal title="Workspace settings" close={close}>
      <div className="stack-form">
        <h3>Model providers</h3>
        <p className="muted">
          Choose a provider and model inside each agent’s settings. Keys are
          read only by the local server.
        </p>
        <div className="provider-list">
          {snapshot.providers.map((p) => (
            <div key={p.id}>
              <div>
                <strong>{p.name}</strong>
                <code>{p.envName}</code>
              </div>
              <span className={p.available ? "success-text" : "muted"}>
                {p.available ? "Connected" : "Not configured"}
              </span>
            </div>
          ))}
        </div>
        <p className="form-note">
          Configure keys in the project’s <code>.env</code> file and restart
          Orbit. Never enter passwords or API keys in an agent chat.
        </p>
        <h3>Workspace folder</h3>
        <code className="path-display">{snapshot.workspacePath}</code>
        <p className="form-note">
          Browser profiles, chats and files stay in this folder. Page content
          needed for a task is sent to that agent’s selected AI provider.
        </p>
        <footer className="form-actions">
          <button className="button primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}

export function ActivityDialog({
  snapshot,
  close,
}: {
  snapshot: AppSnapshot;
  close(): void;
}) {
  const { project } = snapshot;
  return (
    <Modal title="Workspace activity" close={close} wide>
      <div className="activity-list">
        {project.logs.length === 0 && (
          <p className="muted">
            No activity yet. Open a browser to get started.
          </p>
        )}
        {[...project.logs].reverse().map((log) => (
          <div className={`activity-row ${log.level}`} key={log.id}>
            <time>{new Date(log.timestamp).toLocaleTimeString()}</time>
            <span>
              {project.agents.find((a) => a.id === log.agentId)?.name ||
                "Workspace"}
            </span>
            <p>{log.message}</p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
