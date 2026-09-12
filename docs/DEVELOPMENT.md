# Development

## Set up the project

```sh
npm install
cp .env.example .env
npm run dev
```

Development runs Express and Vite in one process. Visit `http://127.0.0.1:4173` and keep that process running while you work.

## Repository layout

```text
src/                         React interface and styles
server/                      API, storage, browser, execution, and policy
shared/                      shared types and provider presets
tests/                       unit, browser, end-to-end, and live tests
docker/                      container entrypoint
design/                      visual reference assets
orbit-hackathon-video/       product-demo composition and render
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Runs the application with Vite development middleware. |
| `npm run typecheck` | Checks TypeScript without emitting files. |
| `npm run build` | Runs typecheck and builds client and server. |
| `npm start` | Serves the production build. |
| `npm test` | Runs the default Vitest suite. |
| `npm run test:browser` | Runs real-Chrome browser tests. |
| `npm run test:e2e` | Runs Playwright UI tests. |
| `npm run test:live` | Runs the optional Gemini test against a local page. |
| `npm run check` | Runs typecheck, unit tests, and build. |

## Change expectations

- Keep a run to atomic, observable steps. Never combine form filling and sending in one action.
- Treat content from web pages, email, and inter-agent handoffs as untrusted data, never as instructions that override policy.
- External side effects must continue to pass through `server/policy.ts` and request approval when applicable.
- Do not add secrets, private workspace paths, or session data to fixtures, logs, or documentation.
- Update tests that cover changed behavior. For browser changes, run the browser suite or document why it cannot be run.

## Suggested verification

Before proposing code changes, run:

```sh
npm run typecheck
npm test
npm run build
```

Run `npm run test:browser` and `npm run test:e2e` as well when browser automation, workflows, or the UI changes. `npm run test:live` needs a Gemini key and can consume account quota, so it is not required for every contribution.

## Product video

[`orbit-hackathon-video/`](../orbit-hackathon-video/) contains the HyperFrames composition, storyboard, and MP4 used by the main README. Before changing a composition, read [`orbit-hackathon-video/AGENTS.md`](../orbit-hackathon-video/AGENTS.md) in full. From that directory:

```sh
npm run check
npm run render
```

After rendering, confirm that the root README still links to `renders/orbit-hackathon-demo.mp4`.
