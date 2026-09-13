# Orbit · Browser Agents

Local control center for workspace browser agents. React Flow + React/TypeScript, Express + Socket.IO, Playwright + Stagehand 3.7.3. macOS and Windows use the same Node application.

## Start

Requires Node **22.18+** and Google Chrome.

```sh
npm install
npm run dev
```

Open [Orbit](http://127.0.0.1:4173). The first launch creates **Hackathon Ops**, with Gmail → Calendar and idle browsers. Those cards show real screenshots only after you open a browser.

Copy `.env.example` to `.env` and supply the keys used by the demo:

```dotenv
OPENROUTER_API_KEY=
EXA_API_KEY=          # Slack research
SLACK_BOT_TOKEN=      # Slack card posts
SLACK_APP_TOKEN=      # optional Tigre Socket Mode bot
```

Orbit loads `.env` from its own directory and then its parent, so the current sibling layout works without copying secrets. Every agent is intentionally pinned to OpenRouter `openrouter/free` for this demo. Browser opening and manual login work without a model key. Keys stay on the server and are never saved in project files or sent to the frontend.

Without installed Chrome, run `npx playwright install chromium` and set `ORBIT_BROWSER_CHANNEL=chromium`. `ORBIT_BROWSER_EXECUTABLE_PATH` can select another Chromium executable.

### Reuse a prepared Chrome window

By default Orbit starts one managed Chrome profile for the workspace. To use tabs from a Chrome window you already prepared, first enable a **local** Chrome DevTools endpoint for a dedicated Chrome profile, manually sign in there, and open the Gmail, Calendar, or Slack tabs. Then start Orbit with a temporary process variable rather than editing `.env`:

```powershell
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--user-data-dir=$env:LOCALAPPDATA\Orbit\chrome-cdp"
)

# After manually opening and signing in to the required tabs in that Chrome window:
$env:ORBIT_BROWSER_CDP_URL = "http://127.0.0.1:9222"
npm run dev
```

Connected-Chrome mode only attaches to an already open matching tab. It neither opens or closes tabs nor reads, copies, or saves that Chrome profile's cookies. If the tab is missing, Orbit reports that instead of launching another Chrome window. Keep the endpoint bound to `127.0.0.1` or `localhost`.

Production:

```sh
npm run build
npm start
```

Stop the dev process first. Both commands use port 4173 (`PORT` overrides it). Only one server may use a workspace root at a time.

## Gmail → Calendar demo

1. Open each browser and log in **manually**. The managed mode shares one workspace profile, so Gmail and Calendar can use the same session. Connected-Chrome mode instead uses the tabs you opened before starting Orbit.
2. Have a meeting request in Gmail with an explicit date, timezone and duration.
3. Click **Run workflow**, review the task, then run it. The first browser reads the request; its structured result is transferred over the edge to the second browser.
4. Watch previews or use **Open Browser**. Respond in the agent’s Chat if information or login is needed.
5. Inspect the exact action and form details in **Attention**, then **Approve** or **Cancel**. Confirm the resulting event in the real Calendar browser.
6. Use each node’s **Logs** for its activity and downloadable artifacts; **Activity** shows workspace events.

Create more nodes with **Add Browser Agent**. Presets only supply a name, icon and URL. Connect a right handle to another node’s left handle. Click an edge to set the recipient’s instruction or disconnect it. Workflows are linear, without forks, joins or cycles; chat alone runs only that node. Creating a workflow uses the + beside WORKFLOWS.

## Slack card

The Slack card reads its **Context**, keeps the browser as its main UI path, and can use `search_web` and `ask_tigre` through Exa. A `post_to_slack` proposal always appears in **Attention** with its exact channel and text; it is sent only after approval. The optional Socket Mode bot in the sibling `tigre/` folder serves mentions and DMs separately.

## Storage and execution

Projects are real folders under `~/Orbit Workspaces/<name-id>` (resolved with `os.homedir()`); `ORBIT_WORKSPACES_DIR` overrides the root.

```text
project.json
events.jsonl
browser-profile/       # managed Chrome profile + private session-cookie snapshot
agents/<uuid>/
  downloads/
  artifacts/
  logs/events.jsonl
  state.json         # own chat, state, result, artifacts
workflows/definitions.json
```

The managed profile is reused, including session cookies that Chrome otherwise discards at shutdown. Connected-Chrome mode never persists cookies. Expired or server-revoked logins still require manual login. Closing Orbit cancels tasks and saves state. Reopening never silently replays pending actions or approvals. Deleting an agent asks for confirmation and permanently deletes its profile and files.

The planner chooses one step at a time. Stagehand observes/extracts; Playwright executes the exact resolved action. Read-only navigation and search can run automatically. State-changing and ambiguous controls require approval, including non-search text fields that might auto-save. This conservative MVP can ask for several approvals when filling a form. A changed target/form invalidates an approval. A failed action stops the run; external writes are never automatically retried. Default limit: 30 steps (`ORBIT_MAX_STEPS`, capped at 100).

Page text is sent to the selected AI provider. Browser profiles stay local. Logs contain observable events, not model reasoning. This is a desktop localhost MVP, not a hosted service or a security sandbox for arbitrary websites. Google can challenge automated Chrome logins; CAPTCHA and 2FA are manual, and connected-Chrome mode is not a bypass for them. The browser abstraction is generic, but site changes, iframe/shadow-DOM complexity and model behavior can still require intervention.

## Team setup

Each collaborator creates their own `.env`, browser profile, and `ORBIT_WORKSPACES_DIR`; do not share Chrome profiles, workspace folders, or DevTools endpoints. Run `npm ci`, then `npm run check` before opening a pull request. `node_modules`, `dist`, `test-results`, `.env`, and the Chrome profile created for connected mode stay local and are ignored. Do not delete `~/Orbit Workspaces` during a demo: it contains the persisted canvas and local browser session.

The Socket Mode bot currently lives in sibling `tigre/`, outside this Git repository. Put it in its own Git repository before sharing it, or explicitly move it into the Orbit repository as a separate change; otherwise a push from `orbit/` will not include it.

## Verify

```sh
npm test               # persistence, provider selection, topology, approval policy
npm run test:browser   # real Chrome: isolation, restart, screenshots, downloads, approvals
npm run test:e2e       # UI: CRUD, canvas restore, handoff, approval, actual fixture submission
npm run build
```

Tests use temporary workspaces and controlled local websites. Workflow tests inject a scripted planner and resolver; they exercise the real runtime and browsers without an API key. They do **not** establish live model quality or Gmail/Calendar compatibility. Real account verification requires provider keys and manual login. No simulated provider or fixture route is available in the production app.
