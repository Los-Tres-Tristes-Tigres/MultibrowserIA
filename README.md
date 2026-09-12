# Orbit · Browser Agents

Local control center for independent browser agents. React Flow + React/TypeScript, Express + Socket.IO, Playwright + Stagehand 3.7.3. macOS and Windows use the same Node application.

## Start

Requires Node **22.18+** and Google Chrome.

```sh
npm install
npm run dev
```

Open [Orbit](http://127.0.0.1:4173). The first launch creates **Hackathon Ops**, with Gmail → Calendar and idle browsers. Those cards show real screenshots only after you open a browser.

Copy `.env.example` to `.env` and supply at least one key:

```dotenv
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=
```

Restart Orbit after changing `.env`. Select the provider and model in each agent’s settings (•••). The model must support structured JSON output. Defaults are editable; model availability depends on your provider account. Browser opening and manual login work without a model key. Keys stay on the server and are never saved in project files or sent to the frontend.

Without installed Chrome, run `npx playwright install chromium` and set `ORBIT_BROWSER_CHANNEL=chromium`. `ORBIT_BROWSER_EXECUTABLE_PATH` can select another Chromium executable.

Production:

```sh
npm run build
npm start
```

Stop the dev process first. Both commands use port 4173 (`PORT` overrides it). Only one server may use a workspace root at a time.

## Gmail → Calendar demo

1. Open each browser and log in **manually**. Every node has a different browser profile; Gmail and Calendar need separate logins even for the same Google account.
2. Have a meeting request in Gmail with an explicit date, timezone and duration. Select an available provider/model in both nodes.
3. Click **Run workflow**, review the task, then run it. The first browser reads the request; its structured result is transferred over the edge to the second browser.
4. Watch previews or use **Open Browser**. Respond in the agent’s Chat if information or login is needed.
5. Inspect the exact action and form details in **Attention**, then **Approve** or **Cancel**. Confirm the resulting event in the real Calendar browser.
6. Use each node’s **Logs** for its activity and downloadable artifacts; **Activity** shows workspace events.

Create more nodes with **Add Browser Agent**. Presets only supply a name, icon and URL. Connect a right handle to another node’s left handle. Click an edge to set the recipient’s instruction or disconnect it. Workflows are linear, without forks, joins or cycles; chat alone runs only that node. Creating a workflow uses the + beside WORKFLOWS.

## Storage and execution

Projects are real folders under `~/Orbit Workspaces/<name-id>` (resolved with `os.homedir()`); `ORBIT_WORKSPACES_DIR` overrides the root.

```text
project.json
events.jsonl
agents/<uuid>/
  browser-profile/   # Chrome profile + private session-cookie snapshot
  downloads/
  artifacts/
  logs/events.jsonl
  state.json         # own chat, state, result, artifacts
workflows/definitions.json
```

Profiles are reused, including session cookies that Chrome otherwise discards at shutdown. Expired or server-revoked logins still require manual login. Closing Orbit cancels tasks and saves state. Reopening never silently replays pending actions or approvals. Deleting an agent asks for confirmation and permanently deletes its profile and files.

The planner chooses one step at a time. Stagehand observes/extracts; Playwright executes the exact resolved action. Read-only navigation and search can run automatically. State-changing and ambiguous controls require approval, including non-search text fields that might auto-save. This conservative MVP can ask for several approvals when filling a form. A changed target/form invalidates an approval. A failed action stops the run; external writes are never automatically retried. Default limit: 30 steps (`ORBIT_MAX_STEPS`, capped at 100).

Page text is sent to the selected AI provider. Browser profiles stay local. Logs contain observable events, not model reasoning. This is a desktop localhost MVP, not a hosted service or a security sandbox for arbitrary websites. Google can challenge automated Chrome logins; CAPTCHA and 2FA are manual. The browser abstraction is generic, but site changes, iframe/shadow-DOM complexity and model behavior can still require intervention.

## Verify

```sh
npm test               # persistence, provider selection, topology, approval policy
npm run test:browser   # real Chrome: isolation, restart, screenshots, downloads, approvals
npm run test:e2e       # UI: CRUD, canvas restore, handoff, approval, actual fixture submission
npm run build
```

Tests use temporary workspaces and controlled local websites. Workflow tests inject a scripted planner and resolver; they exercise the real runtime and browsers without an API key. They do **not** establish live model quality or Gmail/Calendar compatibility. Real account verification requires provider keys and manual login. No simulated provider or fixture route is available in the production app.
