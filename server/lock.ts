import { promises as fs } from "node:fs";

/** One Orbit server per workspace root. */
export async function acquireLock(lockPath: string, pid = process.pid) {
  try {
    await fs.writeFile(lockPath, String(pid), { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const owner = Number(await fs.readFile(lockPath, "utf8"));
  if (!Number.isInteger(owner) || owner <= 0)
    throw new Error(
      "Workspace lock is invalid. Inspect .orbit.lock before starting another process.",
    );
  // A lock with our own PID is stale: restarted containers reuse the same PIDs.
  if (owner !== pid && isAlive(owner))
    throw new Error(
      "Another Orbit process is using this workspace root. Stop it or choose another ORBIT_WORKSPACES_DIR.",
    );
  await fs.unlink(lockPath);
  await fs.writeFile(lockPath, String(pid), { flag: "wx", mode: 0o600 });
}

export async function releaseLock(lockPath: string, pid = process.pid) {
  if ((await fs.readFile(lockPath, "utf8").catch(() => "")) === String(pid))
    await fs.unlink(lockPath);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
