import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, releaseLock } from "../server/lock.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function lockFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-lock-test-"));
  roots.push(root);
  return path.join(root, ".orbit.lock");
}

describe("workspace lock", () => {
  it("refuses a live owner and reclaims locks left by exited processes or by its own PID after a container restart", async () => {
    const file = await lockFile();
    await fs.writeFile(file, String(process.pid));
    await expect(acquireLock(file, process.pid + 1000000)).rejects.toThrow(
      "Another Orbit process",
    );
    await acquireLock(file, process.pid);
    expect(await fs.readFile(file, "utf8")).toBe(String(process.pid));

    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    await fs.writeFile(file, String(exited));
    await acquireLock(file, 4242);
    expect(await fs.readFile(file, "utf8")).toBe("4242");

    await releaseLock(file, 1);
    expect(await fs.readFile(file, "utf8")).toBe("4242");
    await releaseLock(file, 4242);
    await expect(fs.stat(file)).rejects.toThrow();
  });
});
