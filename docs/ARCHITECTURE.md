# Architecture

Orbit is a local Node.js application: React provides the control surface, Express provides the local API, Socket.IO delivers live state updates, and Playwright plus Stagehand operate browser sessions.

## System overview

```text
React + React Flow ── HTTP / Socket.IO ── Express API
                                             │
                   ┌─────────────────────────┼─────────────────────────┐
                   │                         │                         │
             WorkspaceStore             AgentRuntime             BrowserManager
            state and files          runs and approvals       Chrome / Chromium
                   │                         │                         │
                   └────────────────── AI providers ───────────────────┘
                             OpenAI · OpenRouter · Gemini
```

The browser and provider credentials are controlled by the server. The frontend never receives provider keys or operates a browser directly.

## Main modules

| Area | Location | Responsibility |
| --- | --- | --- |
| Client | `src/` | React Flow canvas, forms, modal, attention panel, and API client. |
| API and realtime | `server/app.ts` | HTTP routes, input validation, local-origin protections, and Socket.IO events. |
| Bootstrap | `server/index.ts` | Loads `.env`, locks the workspace root, starts Vite or static serving, and shuts down cleanly. |
| Persistence | `server/store.ts` | Workspaces, agents, logs, queued writes, and safe restoration. |
| Execution | `server/runtime.ts` | Step-by-step planning, agent handoffs, cancellation, and approval decisions. |
| Browser | `server/browser.ts` | Persistent Playwright contexts, profiles, screenshots, downloads, and Stagehand. |
| Policy | `server/policy.ts` | Read-only versus approval-required actions and approval fingerprints. |
| Providers | `server/providers.ts` | Model clients, timeouts, and structured planner output. |
| Shared contracts | `shared/` | Types and provider presets used by client and server. |

## Task lifecycle

1. A user sends an instruction to one agent or starts a workflow.
2. Orbit verifies every selected agent's provider, then opens or restores its browser.
3. The planner receives the instruction, incoming handoff context, and observable page text, then returns one structured step.
4. Stagehand resolves the target; Playwright executes only an allowed, resolved browser method.
5. The policy inspects the proposed action, its actual target, and current form state. Sensitive work waits for user approval.
6. When a workflow agent finishes, its structured result crosses the canvas edge to the next agent. The run completes, cancels, or stops on an error.

Workflow paths are linear. Validation rejects cycles, forks, and joins so every handoff has one unambiguous sender and recipient.

## Local state

By default, data is stored under `~/Orbit Workspaces`; set `ORBIT_WORKSPACES_DIR` to choose another root.

```text
Orbit Workspaces/
├── orbit-shared-browser-profile/    # shared desktop Chrome session
└── <workspace-id>/
    ├── project.json                 # canvas, connections, workflows, project state
    ├── events.jsonl                 # workspace activity
    ├── workflows/definitions.json
    └── agents/<agent-id>/
        ├── browser-profile/         # isolated-session agents only
        ├── downloads/
        ├── artifacts/
        ├── logs/events.jsonl
        └── state.json               # chat, state, result, artifacts
```

Profiles and workspace state persist locally. On restart, Orbit marks active runs as interrupted and expires unresolved approvals; it never silently replays them.

## Browser sessions

Desktop Orbit defaults to **Orbit Shared**, a single persistent Chrome session that gives each shared agent its own tab. `isolated` gives an agent its own persistent profile. Docker always uses isolated profiles because it cannot access the host browser profile.

Changing a session mode requires the agent browser to be closed and idle. It does not delete the previous profile.

## Local API

The application exposes its internal API under `/api` and emits `orbit:event` and `orbit:preview` over Socket.IO. Mutating API requests need the local `X-Orbit-Client: local` header, and requests that are not same-origin local requests are rejected. The API is an internal implementation detail and may change between releases.
