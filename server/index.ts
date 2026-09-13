import path from "node:path";
import { config as loadEnv } from "dotenv";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WorkspaceStore } from "./store.js";
import { BrowserManager } from "./browser.js";
import { AgentRuntime } from "./runtime.js";
import { createApp } from "./app.js";
import { publicError } from "./validation.js";

loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "../.env") });

const store = new WorkspaceStore();
await fs.mkdir(store.root, { recursive: true });
const lockPath = path.join(store.root, ".orbit.lock");
async function acquireLock() {
  try {
    await fs.writeFile(lockPath, String(process.pid), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await fs.readFile(lockPath, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(
        "Workspace lock is invalid. Inspect .orbit.lock before starting another process.",
      );
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive)
      throw new Error(
        "Another Orbit process is using this workspace root. Stop it or choose another ORBIT_WORKSPACES_DIR.",
      );
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, String(process.pid), {
      flag: "wx",
      mode: 0o600,
    });
  }
}
await acquireLock();
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
  if (
    (await fs.readFile(lockPath, "utf8").catch(() => "")) ===
    String(process.pid)
  )
    await fs.unlink(lockPath);
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
    await store.create("Hackathon Ops", true, {
      provider: "openrouter",
      model: "openrouter/free",
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
  browsers.blockedPort = port;
  server.once("error", (error) => {
    console.error(publicError(error));
    void stop().finally(() => process.exit(1));
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Orbit running at http://127.0.0.1:${port}\nWorkspace root: ${store.root}`,
    ),
  );
} catch (error) {
  console.error(publicError(error));
  await stop();
  process.exitCode = 1;
}
