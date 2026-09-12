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

Keys go **only** in `.env`, which Git ignores and Orbit reads. `.env.example` is committed: never put a real key in it.

Restart Orbit after changing `.env`. Select the provider and model in each agent’s settings (•••); the Model field suggests common ids and accepts any other. The model must support structured JSON output. Gemini / Google AI Studio uses `GEMINI_API_KEY` and defaults to `gemini-2.5-flash`. Model availability depends on your provider account. Browser opening and manual login work without a model key. Keys stay on the server and are never saved in project files or sent to the frontend.

Without installed Chrome, run `npx playwright install chromium` and set `ORBIT_BROWSER_CHANNEL=chromium`. `ORBIT_BROWSER_EXECUTABLE_PATH` can select another Chromium executable.

Production:

```sh
npm run build
npm start
```

Stop the dev process first. Both commands use port 4173 (`PORT` overrides it). Only one server may use a workspace root at a time.

## Docker

One container runs Orbit, Chromium agents on a virtual display and a noVNC viewer (linux/amd64 and linux/arm64).

```sh
cp .env.example .env                           # add GEMINI_API_KEY; optionally TZ=America/Lima
docker compose up --build -d
docker compose exec orbit cat /data/.vnc-password
```

- Orbit: <http://127.0.0.1:4173>
- Agent browsers, where you log in manually: <http://127.0.0.1:6080/vnc.html> with the password above. Set `VNC_PASSWORD` in `.env` to choose it (VNC uses the first 8 characters).

Keys are read from `.env` when the container starts and are never copied into the image (`.dockerignore`). Workspaces, Chromium profiles and the viewer password live in the `orbit-data` volume; `docker compose down -v` deletes them. Both ports are published on 127.0.0.1 only. Never publish them on other interfaces: Orbit and the viewer have no login and control your logged-in browsers. `ORBIT_HOST_PORT` and `ORBIT_VNC_HOST_PORT` change the host ports. Agents cannot open Orbit or the viewer (`ORBIT_BLOCKED_PORTS`).

The image uses Playwright’s Chromium because Google Chrome has no Linux arm64 build. Google can treat sign-in in this browser differently from desktop Chrome; if it refuses, run Orbit with `npm run dev` instead. Set `TZ` so agent dates match your calendar. Outside Docker, keep the default `ORBIT_HOST=127.0.0.1`.

## Gmail → Calendar demo

1. Select **Gemini / AI Studio** and a model in the Gmail and Calendar settings (•••).
2. Open each browser and log in **manually**. Every node has a different browser profile; Gmail and Calendar need separate logins even for the same Google account. Orbit never types passwords or handles CAPTCHA/2FA.
3. Send yourself a clearly marked test request, for example subject `[ORBIT-TEST] Meeting request`, with an explicit date, time, timezone and duration, and no other guests.
4. Click **Run workflow**, review the task, then run it. The first browser reads the request; its structured result is transferred over the edge to the second browser (**Incoming context** in the Calendar chat).
5. Watch previews or use **Open Browser**. Respond in the agent’s Chat if information or login is needed.
6. Inspect the exact action and current form fields in **Attention**, then **Approve** or **Cancel**. Cancel stops the whole workflow without acting. If you edit the form while a decision is pending, approving is refused and nothing runs. Confirm the resulting event in the real Calendar browser.
7. Use each node’s **Logs** for its activity and downloadable artifacts; **Activity** shows workspace events.

New starter workspaces give Gmail and Calendar site hints: Gmail search URLs, the Calendar day view and a prefilled `eventedit` draft link. A draft is not saved until Save is approved.

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

The planner chooses one step at a time. Stagehand observes/extracts; Playwright executes the exact resolved action. Read-only navigation, scrolling and search can run automatically. State-changing and ambiguous controls require approval, including non-search text fields that might auto-save, typed line breaks and script links (`href="#"`). This conservative MVP can ask for several approvals when filling a form. An approval records the target and the values of its form (a form, a dialog, or the nearest container with fields); if they change, the action is not executed. If a target cannot be resolved, nothing runs and the planner is told; three consecutive failures stop the run. A failed action stops the run; external writes are never automatically retried. Default limit: 30 steps (`ORBIT_MAX_STEPS`, capped at 100).

Page text is sent to the selected AI provider. Browser profiles stay local. Logs contain observable events, not model reasoning, and errors are redacted before they reach logs or the UI. This is a desktop localhost MVP, not a hosted service or a security sandbox for arbitrary websites. Google can challenge automated Chrome logins; CAPTCHA and 2FA are manual. The browser abstraction is generic, but site changes, iframe/shadow-DOM complexity and model behavior can still require intervention.

## Verify

```sh
npm test               # persistence, provider selection, topology, approval policy, redaction
npm run test:browser   # real Chrome: isolation, restart, screenshots, downloads, approvals, cancellation
npm run test:e2e       # UI: CRUD, canvas restore, handoff, approval, actual fixture submission
npm run test:live      # opt-in, real Gemini: planner + Stagehand on a local page; never acts
npm run build
```

Tests use temporary workspaces and controlled local websites. Workflow tests inject a scripted planner and resolver; they exercise the real runtime and browsers without an API key. `test:live` calls Gemini with `GEMINI_API_KEY` from `.env` (`ORBIT_LIVE_GEMINI_MODEL` selects another model) and skips without a key. None of them establish Gmail/Calendar compatibility: real account verification requires manual login. No simulated provider or fixture route is available in the production app.
