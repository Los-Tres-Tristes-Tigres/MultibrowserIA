import { useState } from "react";
import {
  Plus,
  Play,
  Settings2,
  ChevronDown,
  Check,
  Activity,
  List,
  X,
  LoaderCircle,
  AlertCircle,
  FolderOpen,
} from "lucide-react";
import { useOrbit } from "./useOrbit";
import { api, agentUrl } from "./api";
import { AppIcon, OrbitLogo } from "./components/Icons";
import { Canvas } from "./components/Canvas";
import { Attention } from "./components/Attention";
import {
  AgentForm,
  ProjectForm,
  WorkflowForm,
  SettingsDialog,
  ActivityDialog,
} from "./components/Forms";
import { statusClass } from "./components/AgentNode";

type Dialog =
  | { type: "agent"; id?: string }
  | { type: "workflow"; id?: string }
  | { type: "project" | "settings" | "activity" };
export function App() {
  const orbit = useOrbit();
  const { snapshot } = orbit;
  const [dialog, setDialog] = useState<Dialog>();
  const [selectedId, setSelectedId] = useState<string>();
  const [chatId, setChatId] = useState<string>();
  const [projectMenu, setProjectMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingId, setOpeningId] = useState("");
  const close = () => setDialog(undefined);
  if (!snapshot)
    return (
      <div className="app-loading">
        <OrbitLogo />
        <h1>Orbit</h1>
        <p>{orbit.error || "Opening your workspace…"}</p>
        {orbit.error ? (
          <button className="button" onClick={() => void orbit.refresh()}>
            Try again
          </button>
        ) : (
          <LoaderCircle className="spin" size={21} />
        )}
      </div>
    );
  const { project } = snapshot;
  const select = (id?: string, chat = false) => {
    setSelectedId(id);
    setChatId(chat ? id : undefined);
  };
  const openBrowser = async (id: string) => {
    setOpeningId(id);
    try {
      await orbit.perform(() =>
        api(`${agentUrl(project.id, id)}/browser`, "POST"),
      );
    } catch {
      /* toast */
    } finally {
      setOpeningId("");
    }
  };
  const onChat = async (id: string, text: string) => {
    await orbit.perform(() =>
      api(`${agentUrl(project.id, id)}/messages`, "POST", { text }),
    );
  };
  const stop = (runId: string) => {
    void orbit
      .perform(() =>
        api(`/projects/${project.id}/runs/${runId}/cancel`, "POST"),
      )
      .catch(() => {});
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <OrbitLogo />
          <h1>Orbit</h1>
        </div>
        <span className="top-divider" />
        <div className="workspace-switcher">
          <button
            onClick={() => setProjectMenu(!projectMenu)}
            className="workspace-button"
            aria-expanded={projectMenu}
          >
            {project.name}
            <ChevronDown size={16} />
          </button>
          {projectMenu && (
            <>
              <button
                className="menu-dismiss"
                onClick={() => setProjectMenu(false)}
                aria-label="Close workspace menu"
              />
              <div className="workspace-menu">
                {snapshot.projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      orbit.selectProject(p.id);
                      setProjectMenu(false);
                      select(undefined);
                    }}
                  >
                    <FolderOpen size={16} />
                    {p.name}
                    {p.id === project.id && <Check size={15} />}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setProjectMenu(false);
                    setDialog({ type: "project" });
                  }}
                >
                  <Plus size={16} />
                  New workspace
                </button>
              </div>
            </>
          )}
        </div>
        <div className="topbar-right">
          <button
            className="button primary run-button"
            onClick={() => setDialog({ type: "workflow" })}
            disabled={!project.agents.length}
          >
            <Play size={16} fill="currentColor" />
            Run workflow
          </button>
          <span className={`save-state ${orbit.connected ? "" : "offline"}`}>
            <span
              className={`status-dot ${orbit.connected ? "completed" : "error"}`}
            />
            {orbit.connected
              ? saving
                ? "Saving…"
                : "Saved locally"
              : "Disconnected"}
            {orbit.connected && !saving && <Check size={15} />}
          </span>
          <span className="top-divider" />
          <button
            className="icon-button settings-button"
            aria-label="Workspace settings"
            onClick={() => setDialog({ type: "settings" })}
          >
            <Settings2 size={21} />
          </button>
        </div>
      </header>
      <div className="workspace-layout">
        <aside className="sidebar">
          <div className="sidebar-section-heading">BROWSER AGENTS</div>
          <nav className="agent-list">
            {project.agents.map((a) => (
              <button
                key={a.id}
                className={`agent-list-item ${selectedId === a.id ? "selected" : ""}`}
                onClick={() => select(a.id, true)}
              >
                <AppIcon preset={a.preset} size={27} />
                <span>{a.name}</span>
                <span
                  className={`status-dot ${statusClass(a.status)}`}
                  title={a.status}
                />
              </button>
            ))}
          </nav>
          <button
            className="button add-agent"
            onClick={() => setDialog({ type: "agent" })}
          >
            <Plus size={19} />
            Add Browser Agent
          </button>
          <div className="sidebar-rule" />
          <div className="sidebar-section-heading workflow-heading">
            WORKFLOWS
            <button
              className="icon-button"
              aria-label="Create workflow"
              onClick={() => setDialog({ type: "workflow", id: "new" })}
              disabled={!project.agents.length}
            >
              <Plus size={15} />
            </button>
          </div>
          <nav className="workflow-list">
            {project.workflows.map((w) => (
              <button
                key={w.id}
                className="workflow-list-item"
                onClick={() => setDialog({ type: "workflow", id: w.id })}
              >
                <List size={20} />
                <span>{w.name}</span>
              </button>
            ))}
            {!project.workflows.length && (
              <p className="sidebar-note">
                Connect agents on the canvas
                <br />
                to build your first workflow.
              </p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <button onClick={() => setDialog({ type: "activity" })}>
              <Activity size={17} />
              Activity<span>{project.logs.length || ""}</span>
            </button>
            <div className="local-label">
              <span className="status-dot completed" />
              Local workspace
            </div>
          </div>
        </aside>
        <Canvas
          key={project.id}
          snapshot={snapshot}
          previews={orbit.previews}
          activeEdge={orbit.activeEdge}
          selectedId={selectedId}
          chatId={chatId}
          onSelect={(id) => select(id)}
          onBrowser={(id) => void openBrowser(id)}
          onSettings={(id) => setDialog({ type: "agent", id })}
          onChat={onChat}
          onStop={stop}
          onAdd={() => setDialog({ type: "agent" })}
          refresh={orbit.refresh}
          report={orbit.setError}
          onSaving={setSaving}
        />
        <Attention
          project={project}
          onDecide={async (id, approve) => {
            await orbit.perform(() =>
              api(`/projects/${project.id}/approvals/${id}`, "POST", {
                approve,
              }),
            );
          }}
          onSelect={(id) => select(id, true)}
          onStop={stop}
        />
      </div>
      {openingId && (
        <div className="browser-opening">
          <LoaderCircle className="spin" size={17} />
          Opening {project.agents.find((a) => a.id === openingId)?.name} in
          Chrome…
        </div>
      )}
      {orbit.error && (
        <div className="toast" role="alert">
          <AlertCircle size={20} />
          <p>{orbit.error}</p>
          <button
            className="icon-button"
            onClick={() => orbit.setError("")}
            aria-label="Dismiss error"
          >
            <X size={17} />
          </button>
        </div>
      )}
      {dialog?.type === "agent" && (
        <AgentForm
          snapshot={snapshot}
          agent={project.agents.find((a) => a.id === dialog.id)}
          close={close}
          saved={orbit.refresh}
        />
      )}
      {dialog?.type === "workflow" && (
        <WorkflowForm
          snapshot={snapshot}
          workflowId={dialog.id}
          close={close}
          saved={orbit.refresh}
        />
      )}
      {dialog?.type === "project" && (
        <ProjectForm close={close} created={orbit.selectProject} />
      )}
      {dialog?.type === "settings" && (
        <SettingsDialog snapshot={snapshot} close={close} />
      )}
      {dialog?.type === "activity" && (
        <ActivityDialog snapshot={snapshot} close={close} />
      )}
    </div>
  );
}
