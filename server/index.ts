import "dotenv/config";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WorkspaceStore } from "./store.js";
import { BrowserManager } from "./browser.js";
import { AgentRuntime } from "./runtime.js";
import { createApp } from "./app.js";
import { providerInfo } from "./providers.js";
import { publicError } from "./validation.js";
import { acquireLock, releaseLock } from "./lock.js";

const store = new WorkspaceStore();
await fs.mkdir(store.root, { recursive: true });
const lockPath = path.join(store.root, ".orbit.lock");
await acquireLock(lockPath);
const browsers = new BrowserManager(store);
const runtime = new AgentRuntime(store, browsers);
const { app, server, io } = createApp(store, browsers, runtime);
let vite: { close(): Promise<void> } | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.shutdown();
  await store.flush();
  await vite?.close();
  io.close();
  server.close();
  await releaseLock(lockPath);
}
process.on("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
try {
  await store.init();
  if (!store.list().length) {
    const p = providerInfo().find((p) => p.available) || providerInfo()[0];
    await store.create("Hackathon Ops", true, {
      provider: p.id,
      model: p.defaultModel,
    });
  }
  const production = process.argv.includes("--production");
  if (production) {
    const clientRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../client",
    );
    app.use(express.static(clientRoot));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.join(clientRoot, "index.html")),
    );
  } else {
    const { createServer } = await import("vite");
    const development = await createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    vite = development;
    app.use(development.middlewares);
  }
  const port = Number(process.env.PORT || 4173);
  // Docker listens on 0.0.0.0 inside the container and publishes the port on the host loopback only.
  const host = process.env.ORBIT_HOST || "127.0.0.1";
  // Agents may never open Orbit itself or local control services such as the Docker noVNC viewer.
  for (const value of [
    port,
    ...(process.env.ORBIT_BLOCKED_PORTS || "").split(","),
  ]) {
    const blocked = Number(value);
    if (Number.isInteger(blocked) && blocked > 0 && blocked < 65536)
      browsers.blockedPorts.add(blocked);
  }
  server.once("error", (error) => {
    console.error(publicError(error));
    void stop().finally(() => process.exit(1));
  });
  server.listen(port, host, () =>
    console.log(
      `Orbit running at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}\nWorkspace root: ${store.root}`,
    ),
  );
} catch (error) {
  console.error(publicError(error));
  await stop();
  process.exitCode = 1;
}
