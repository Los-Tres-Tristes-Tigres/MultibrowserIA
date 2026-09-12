/** Isolated UI test server. Scripted intelligence is used ONLY here, never in Orbit. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { WorkspaceStore } from "../server/store.js";
import { AgentRuntime } from "../server/runtime.js";
import { createApp } from "../server/app.js";
import { FixtureBrowser, fixturePlanner, startFixtures } from "./fixtures.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-ui-test-"));
const store = new WorkspaceStore(root);
await store.init();
const fixtures = await startFixtures(4175);
const browsers = new FixtureBrowser(store, { headless: true });
browsers.blockedPort = 4174;
const runtime = new AgentRuntime(store, browsers, {
  planner: fixturePlanner,
  checkProvider: () => {},
});
const p = await store.create("Hackathon Ops", true);
p.agents[0].url = p.agents[0].currentUrl = fixtures.url + "/inbox";
p.agents[1].url = p.agents[1].currentUrl = fixtures.url + "/calendar";
await store.save(p.id);
const { app, server, io } = createApp(store, browsers, runtime);
const vite = await createServer({
  server: { middlewareMode: true, hmr: { server } },
  appType: "spa",
});
app.use(vite.middlewares);
server.listen(4174, "127.0.0.1", () =>
  console.log("Orbit UI test server ready."),
);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await runtime.shutdown();
  await store.flush();
  await vite.close();
  io.close();
  server.close();
  await fixtures.close();
  await fs.rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
