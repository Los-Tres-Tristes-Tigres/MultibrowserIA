import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleCheck,
  CircleAlert,
  LoaderCircle,
  Square,
  Clock3,
} from "lucide-react";
import type { ProjectState } from "../../shared/types";
import { AppIcon } from "./Icons";

const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export function Attention({
  project,
  onDecide,
  onSelect,
  onStop,
}: {
  project: ProjectState;
  onDecide(id: string, value: boolean): Promise<void>;
  onSelect(id: string): void;
  onStop(runId: string): void;
}) {
  const [busyId, setBusyId] = useState("");
  const decisions = project.approvals.filter((a) => a.status === "pending");
  const pending = project.agents.filter(
    (a) =>
      a.activeRunId &&
      a.status !== "Needs Approval" &&
      a.status !== "Completed",
  );
  const errors = project.agents.filter((a) => a.status === "Error");
  const decide = async (id: string, value: boolean) => {
    setBusyId(id);
    try {
      await onDecide(id, value);
    } catch {
      /* Parent shows error */
    } finally {
      setBusyId("");
    }
  };
  return (
    <aside className="attention">
      <header>
        <h2>ATTENTION</h2>
        <span className="attention-count">
          {decisions.length + errors.length}
        </span>
      </header>
      {decisions.length > 0 && (
        <section className="attention-section">
          <h3>
            <span className="status-dot needs-approval" />
            DECISIONS
          </h3>
          {decisions.map((request) => {
            const agent = project.agents.find((a) => a.id === request.agentId);
            if (!agent) return null;
            return (
              <article className="decision" key={request.id}>
                <div className="attention-agent">
                  <AppIcon preset={agent.preset} size={24} />
                  <button onClick={() => onSelect(agent.id)}>
                    {agent.name} Agent
                  </button>
                  <ArrowUpRight size={15} />
                </div>
                <h4>{request.title}</h4>
                <p className="decision-url">{hostname(request.url)}</p>
                <details open>
                  <summary>
                    Review exact action
                    <ChevronDown size={13} />
                  </summary>
                  <pre>{request.description}</pre>
                </details>
                <div className="decision-actions">
                  <button
                    className="button primary"
                    disabled={busyId === request.id}
                    onClick={() => void decide(request.id, true)}
                  >
                    <Check size={15} />
                    Approve
                  </button>
                  <button
                    className="button"
                    disabled={busyId === request.id}
                    onClick={() => void decide(request.id, false)}
                  >
                    Cancel
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
      {pending.length > 0 && (
        <section className="attention-section">
          <h3>
            <span className="status-dot thinking" />
            PENDING
          </h3>
          {pending.map((agent) => (
            <div className="pending-agent" key={agent.id}>
              <div className="attention-agent">
                <AppIcon preset={agent.preset} size={23} />
                <button onClick={() => onSelect(agent.id)}>
                  {agent.name} Agent
                </button>
                {agent.status === "Waiting" ? (
                  <Clock3 size={15} />
                ) : (
                  <LoaderCircle className="spin" size={15} />
                )}
              </div>
              <p>{agent.currentAction}</p>
              <div className="pending-actions">
                {agent.waitingForReply && (
                  <button onClick={() => onSelect(agent.id)}>
                    Open chat
                    <ArrowUpRight size={12} />
                  </button>
                )}
                <button onClick={() => onStop(agent.activeRunId!)}>
                  <Square size={11} />
                  Stop task
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      {errors.length > 0 && (
        <section className="attention-section">
          <h3>
            <CircleAlert size={15} />
            ERRORS
          </h3>
          {errors.map((agent) => (
            <div className="attention-error" key={agent.id}>
              <div className="attention-agent">
                <AppIcon preset={agent.preset} size={23} />
                <button onClick={() => onSelect(agent.id)}>
                  {agent.name} Agent
                </button>
              </div>
              <p>{agent.currentAction}</p>
              <button
                className="text-button"
                onClick={() => onSelect(agent.id)}
              >
                Review in chat
                <ArrowUpRight size={13} />
              </button>
            </div>
          ))}
        </section>
      )}
      {!decisions.length && !pending.length && !errors.length && (
        <div className="all-clear">
          <div className="all-clear-icon">
            <CircleCheck size={29} strokeWidth={1.4} />
          </div>
          <h3>All clear</h3>
          <p>
            Decisions and tasks that need
            <br />
            you will appear here.
          </p>
        </div>
      )}
      <div className="attention-footer">
        <span className="tiny-orbit" />
        <span>You’re always in control.</span>
      </div>
    </aside>
  );
}
