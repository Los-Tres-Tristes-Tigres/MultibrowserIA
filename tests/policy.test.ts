import { describe, expect, it } from "vitest";
import {
  fingerprint,
  navigationNeedsApproval,
  requiresApproval,
  type TargetEvidence,
} from "../server/policy.js";
import { validateConnections, webUrl } from "../server/validation.js";
const target: TargetEvidence = {
  url: "https://example.com/event",
  tag: "button",
  role: "",
  type: "",
  label: "",
  text: "",
  href: "",
  inSearch: false,
  editable: false,
  attributes: "name=|type=|role=",
  fields: [{ label: "Title", value: "Meeting" }],
  formText: "Title Save",
};
const action = {
  selector: "#save",
  description: "",
  method: "click",
  arguments: [],
};
describe("approval boundary", () => {
  it.each([
    "Send email",
    "Create event",
    "Save",
    "Delete",
    "Enviar",
    "Guardar",
    "Crear evento",
    "Submit form",
    "Buy now",
  ])("blocks %s even when a model labels it as reading", (label) => {
    expect(
      requiresApproval({ impact: "read", instruction: "click it" }, action, {
        ...target,
        label,
      }),
    ).toBe(true);
  });
  it("allows a search field but requires approval for unknown and autosaving controls", () => {
    const fill = { ...action, method: "fill", arguments: ["Hackathon"] };
    expect(
      requiresApproval(
        { impact: "search", instruction: "Search hackathon" },
        fill,
        { ...target, tag: "input", inSearch: true, editable: true },
      ),
    ).toBe(false);
    expect(
      requiresApproval({ impact: "read", instruction: "Fill title" }, fill, {
        ...target,
        tag: "input",
        editable: true,
      }),
    ).toBe(true);
    expect(
      requiresApproval(
        { impact: "read", instruction: "Click" },
        action,
        target,
      ),
    ).toBe(true);
  });
  it("requires approval for typed line breaks and scripted links, not for plain links or scrolling", () => {
    expect(
      requiresApproval(
        { impact: "search", instruction: "Search hackathon" },
        { ...action, method: "type", arguments: ["hackathon\n"] },
        { ...target, tag: "input", inSearch: true, editable: true },
      ),
    ).toBe(true);
    const link = { ...target, tag: "a", text: "Details" };
    const open = { impact: "navigation" as const, instruction: "Open details" };
    expect(
      requiresApproval(open, action, {
        ...link,
        href: "https://example.com/details",
      }),
    ).toBe(false);
    expect(
      requiresApproval(open, action, {
        ...link,
        href: "https://example.com/event#",
      }),
    ).toBe(true);
    expect(
      requiresApproval(
        { impact: "read", instruction: "Show more results" },
        { ...action, method: "nextChunk" },
        target,
      ),
    ).toBe(false);
  });
  it("requires approval for dangerous navigation and changes the fingerprint when form data changes", () => {
    expect(
      navigationNeedsApproval("https://example.com/delete?id=1", "navigation"),
    ).toBe(true);
    expect(fingerprint(target)).toBe(fingerprint({ ...target }));
    expect(fingerprint(target)).not.toBe(
      fingerprint({
        ...target,
        fields: [{ label: "Title", value: "Another meeting" }],
      }),
    );
    expect(webUrl.safeParse("javascript:alert(1)").success).toBe(false);
    expect(webUrl.safeParse("file:///etc/passwd").success).toBe(false);
  });
});
describe("workflow topology", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const edge = (source: string, target: string) => ({
    id: `${source}-${target}`,
    source,
    target,
    instruction: "",
  });
  it("permits chains and rejects cycles, forks, merges and missing agents", () => {
    expect(() =>
      validateConnections(agents, [edge("a", "b"), edge("b", "c")]),
    ).not.toThrow();
    for (const edges of [
      [edge("a", "b"), edge("b", "a")],
      [edge("a", "b"), edge("a", "c")],
      [edge("a", "c"), edge("b", "c")],
      [edge("a", "unknown")],
    ])
      expect(() => validateConnections(agents, edges)).toThrow();
  });
});
