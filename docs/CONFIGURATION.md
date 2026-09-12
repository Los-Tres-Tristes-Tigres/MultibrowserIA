# Configuration

Orbit loads environment variables from `.env` when it starts. Copy the example file and keep actual secrets out of version control.

```sh
cp .env.example .env
```

## AI providers

Configure at least one key to run AI tasks. Multiple keys are supported; choose a configured provider and model for each agent in the UI.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI models. |
| `OPENROUTER_API_KEY` | Models accessed through OpenRouter. |
| `GEMINI_API_KEY` | Google AI Studio / Gemini models. |
| `ORBIT_LIVE_GEMINI_MODEL` | Gemini model for `npm run test:live`; defaults to `gemini-2.5-flash`. |

Manual browser login and browser opening do not require a provider key.

## Server and storage

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4173` | Orbit HTTP port. |
| `ORBIT_HOST` | `127.0.0.1` | Listen address. Docker uses `0.0.0.0` internally and publishes only to loopback. |
| `ORBIT_WORKSPACES_DIR` | `~/Orbit Workspaces` | Root for workspaces, profiles, and logs. |
| `ORBIT_MAX_STEPS` | `30` | Maximum steps in one run; the server caps it at 100. |
| `ORBIT_BLOCKED_PORTS` | empty | Comma-separated local ports that agents cannot open. Orbit's own port is always blocked. |

Run only one Orbit process against a workspace root at a time. Orbit uses a lock file to protect against concurrent writes.

## Browser and sessions

| Variable | Default | Description |
| --- | --- | --- |
| `ORBIT_BROWSER_CHANNEL` | `chrome` | Playwright browser channel. Use `chromium` after installing Playwright Chromium. |
| `ORBIT_BROWSER_EXECUTABLE_PATH` | empty | Absolute path to another Chromium executable; takes precedence over the channel. |
| `ORBIT_DEFAULT_BROWSER_SESSION` | `shared` | Default for new agents: `shared` or `isolated`. |
| `ORBIT_SHARED_BROWSER` | `true` | Set to `false` to turn off shared sessions. |

When Chrome is not available:

```sh
npx playwright install chromium
```

```dotenv
ORBIT_BROWSER_CHANNEL=chromium
```

## Docker

| Variable | Default | Description |
| --- | --- | --- |
| `ORBIT_HOST_PORT` | `4173` | Host port for Orbit. |
| `ORBIT_VNC_HOST_PORT` | `6080` | Host port for noVNC. |
| `VNC_PASSWORD` | generated | noVNC password; only its first eight characters are used. |
| `TZ` | `UTC` | Container and browser timezone. |
| `ORBIT_SCREEN` | `1920x1080x24` | Xvfb virtual-screen dimensions and color depth. |

`compose.yaml` sets `ORBIT_SHARED_BROWSER=false` and `ORBIT_DEFAULT_BROWSER_SESSION=isolated`. Persistent data is held by the `orbit-data` volume.

## Minimal example

```dotenv
# .env
GEMINI_API_KEY=paste-your-key-here
TZ=America/Lima
```

Restart Orbit, or recreate the Docker container, after changing `.env`.
