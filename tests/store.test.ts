import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../server/store.js";
const roots: string[] = [];
async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-store-test-"));
  roots.push(root);
  const s = new WorkspaceStore(root);
  await s.init();
  return s;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
describe("local workspaces", () => {
  it("restores nodes, positions, connections, isolated chats and browser profile data", async () => {
    const s = await store();
    const p = await s.create("Test project", true);
    const [a, b] = p.agents;
    expect(s.agentPath(p.id, a.id)).not.toEqual(s.agentPath(p.id, b.id));
    a.position = { x: -80, y: 410 };
    p.viewport = { x: 50, y: 60, zoom: 0.7 };
    a.chatHistory.push({
      id: "chat-one",
      role: "user",
      text: "Private to Gmail",
      timestamp: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(s.agentPath(p.id, a.id), "browser-profile", "profile-marker"),
      "session survives",
    );
    await s.save(p.id);
    const restored = new WorkspaceStore(s.root);
    await restored.init();
    const loaded = restored.get(p.id);
    expect(loaded.agents[0].position).toEqual({ x: -80, y: 410 });
    expect(loaded.agents[0].chatHistory[0].text).toBe("Private to Gmail");
    expect(loaded.agents[1].chatHistory).toEqual([]);
    expect(loaded.connections).toEqual(p.connections);
    expect(loaded.viewport).toEqual(p.viewport);
    expect(
      await fs.readFile(
        path.join(s.agentPath(p.id, a.id), "browser-profile", "profile-marker"),
        "utf8",
      ),
    ).toBe("session survives");
  });
  it("expires pending approvals and interrupts runs after a restart without executing them", async () => {
    const s = await store();
    const p = await s.create("Recovery", true);
    const a = p.agents[0];
    a.activeRunId = "run";
    a.status = "Needs Approval";
    p.runs.push({
      id: "run",
      instruction: "Send",
      agentIds: [a.id],
      currentAgentId: a.id,
      status: "waiting",
      createdAt: new Date().toISOString(),
    });
    p.approvals.push({
      id: "approval",
      agentId: a.id,
      runId: "run",
      title: "Send",
      description: "Send it",
      url: a.url,
      action: {
        method: "click",
        selector: "#send",
        description: "Send",
        arguments: [],
      },
      fingerprint: "hash",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    await s.save(p.id);
    const recovered = new WorkspaceStore(s.root);
    await recovered.init();
    expect(recovered.get(p.id).approvals[0].status).toBe("expired");
    expect(recovered.get(p.id).runs[0].status).toBe("interrupted");
    expect(recovered.get(p.id).agents[0].activeRunId).toBeUndefined();
  });
  it("removes exactly the chosen profile and its connections", async () => {
    const s = await store();
    const p = await s.create("Delete", true);
    const [a, b] = p.agents;
    await s.removeAgent(p.id, a.id);
    expect(await fs.stat(s.agentPath(p.id, a.id)).catch(() => null)).toBeNull();
    expect((await fs.stat(s.agentPath(p.id, b.id))).isDirectory()).toBe(true);
    expect(p.connections).toHaveLength(0);
    expect(p.agents.map((a) => a.id)).toEqual([b.id]);
    expect(() => s.agentPath(p.id, "../escape")).toThrow();
  });
});
