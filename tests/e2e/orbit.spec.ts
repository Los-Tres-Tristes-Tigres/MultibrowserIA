import { test, expect } from "@playwright/test";
import os from "node:os";
import path from "node:path";
test("create, move, configure and remove a browser agent; persist the canvas", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page).toHaveTitle("Orbit · Browser Agents");
  await page
    .getByRole("button", { name: "Add Browser Agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Custom Website", exact: true })
    .click();
  await expect(page.getByLabel("Browser session")).toHaveValue("shared");
  await expect(page.getByText("Sign in once.")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Docs");
  await page.getByLabel("Website URL").fill("https://example.com/");
  await page.getByLabel("AI provider").selectOption("gemini");
  await page.getByLabel("Model", { exact: true }).fill("gemini-2.5-flash");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(
    page.locator(".agent-list-item").filter({ hasText: "Docs" }),
  ).toBeVisible();
  const node = page.getByRole("article", { name: "Docs Browser Agent" });
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  const header = node.locator(".node-header");
  const start = await header.boundingBox();
  await page.mouse.move(start!.x + 80, start!.y + 22);
  await page.mouse.down();
  await page.mouse.move(start!.x + 180, start!.y + 122, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const before = await page.request.get("/api/snapshot").then((r) => r.json());
  await page.reload();
  await expect(
    page.locator(".agent-list-item").filter({ hasText: "Docs" }),
  ).toBeVisible();
  const after = await page.request.get("/api/snapshot").then((r) => r.json());
  expect(
    after.project.agents.find((a: { name: string }) => a.name === "Docs")
      .position,
  ).toEqual(
    before.project.agents.find((a: { name: string }) => a.name === "Docs")
      .position,
  );
  await page.getByRole("button", { name: "Settings for Docs" }).click();
  await expect(page.getByLabel("AI provider")).toHaveValue("gemini");
  await expect(page.getByLabel("Browser session")).toHaveValue("shared");
  // The form always sends its session mode: saving without switching it keeps the status.
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(node.locator(".node-status p")).toHaveText(
    "Open browser to get started",
  );
  await page.getByRole("button", { name: "Settings for Docs" }).click();
  await page.getByRole("button", { name: "Delete agent", exact: true }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.locator(".agent-list-item").filter({ hasText: "Docs" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.waitForTimeout(350);
  const line = await page
    .locator(".react-flow__edge-interaction")
    .boundingBox();
  await page.mouse.click(line!.x + line!.width / 2, line!.y + line!.height / 2);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  const source = page
    .getByRole("article", { name: "Gmail Browser Agent" })
    .locator(".react-flow__handle-right");
  const target = page
    .getByRole("article", { name: "Calendar Browser Agent" })
    .locator(".react-flow__handle-left");
  await source.dragTo(target);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  expect(errors).toEqual([]);
});
test("real browser handoff and approvals update the canvas and create one fixture event", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Run workflow", exact: true })
    .click();
  await expect(
    page.locator(".decision").filter({ hasText: "Enter event title" }),
  ).toBeVisible({ timeout: 40000 });
  await expect(page.locator(".agent-node.state-needs-approval")).toHaveCount(1);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".decision h4")).toHaveText(
    "Create event: Hackathon meeting",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.waitForTimeout(750);
  await page.screenshot({
    path: path.join(os.tmpdir(), "orbit-approval.png"),
    fullPage: false,
  });
  const before = await request
    .get("http://127.0.0.1:4175/state")
    .then((r) => r.json());
  expect(before.events).toHaveLength(0);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Calendar Browser Agent" })
      .locator(".status-badge"),
  ).toHaveText("Completed", { timeout: 20000 });
  const after = await request
    .get("http://127.0.0.1:4175/state")
    .then((r) => r.json());
  expect(after.events).toEqual(["Hackathon meeting"]);
  await page
    .getByRole("article", { name: "Calendar Browser Agent" })
    .getByRole("button", { name: "Logs", exact: true })
    .click();
  await expect(
    page
      .getByRole("article", { name: "Calendar Browser Agent" })
      .getByText("Verified: Hackathon meeting was created in Calendar.", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("article", { name: "Calendar Browser Agent" })
    .getByRole("button", { name: "Chat", exact: true })
    .click();
  await expect(
    page.getByText("Incoming context", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("article", { name: "Calendar Browser Agent" })
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  await page.screenshot({
    path: path.join(os.tmpdir(), "orbit-completed.png"),
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
