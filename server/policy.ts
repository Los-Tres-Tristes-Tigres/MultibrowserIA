import { createHash } from "node:crypto";
import type { BrowserAction } from "../shared/types.js";
import type { AgentStep } from "./providers.js";

export interface FormField {
  label: string;
  value: string;
}
export interface TargetEvidence {
  url: string;
  tag: string;
  role: string;
  type: string;
  label: string;
  text: string;
  href: string;
  inSearch: boolean;
  editable: boolean;
  /** Semantic attributes only: hover/focus classes and styles must not invalidate an approval. */
  attributes: string;
  /** Values in the target's logical form: a form or dialog, or the nearest container with fields. */
  fields: FormField[];
  formText: string;
}
const externalWords =
  /\b(send|submit|save|create|delete|remove|purchase|buy|pay|checkout|publish|post|invite|confirm|accept|approve|unsubscribe|archive|trash|upload|enviar|guardar|crear|eliminar|borrar|comprar|pagar|publicar|invitar|confirmar|aceptar|archivar)\b/i;
const dangerousUrl =
  /(?:logout|signout|delete|remove|unsubscribe|archive|purchase|checkout|submit|send|confirm|invite|\/save)(?:[/?#=&_-]|$)/i;
const readOnlyMethods = new Set([
  "scrollTo",
  "scrollIntoView",
  "hover",
  "nextChunk",
  "prevChunk",
]);

// href="#" or a link back to the current document usually runs a script instead of navigating.
function scriptedLink(target: TargetEvidence) {
  try {
    const href = new URL(target.href);
    const page = new URL(target.url);
    return (
      href.hash.length <= 1 &&
      `${href.origin}${href.pathname}${href.search}` ===
        `${page.origin}${page.pathname}${page.search}`
    );
  } catch {
    return true;
  }
}

export function requiresApproval(
  step: Pick<AgentStep, "impact" | "instruction">,
  action: BrowserAction,
  target: TargetEvidence,
) {
  // The model can request stricter policy, never waive it. Inspect the actual target.
  if (step.impact === "external" || step.impact === "uncertain") return true;
  const intent = `${target.label} ${target.text} ${action.description} ${step.instruction}`;
  if (externalWords.test(intent) || dangerousUrl.test(target.href)) return true;
  // A typed line break can submit a form, even from a search box.
  if (action.arguments.some((value) => /[\r\n]/.test(value))) return true;
  if (readOnlyMethods.has(action.method)) return false;
  if (target.inSearch && ["fill", "type", "click"].includes(action.method))
    return false;
  if (
    target.inSearch &&
    action.method === "press" &&
    ["Enter", "ArrowDown", "ArrowUp", "Escape"].includes(action.arguments[0])
  )
    return false;
  if (action.method === "press" && action.arguments[0] === "Escape")
    return false;
  if (
    action.method === "click" &&
    ["a", "link"].some(
      (value) => value === target.tag || value === target.role,
    ) &&
    /^https?:/.test(target.href) &&
    !target.editable &&
    !scriptedLink(target)
  )
    return false;
  // Unknown controls and non-search editors may auto-save: fail closed.
  return true;
}
export function navigationNeedsApproval(
  url: string,
  impact: AgentStep["impact"],
) {
  return (
    impact === "external" || impact === "uncertain" || dangerousUrl.test(url)
  );
}
export function fingerprint(target: TargetEvidence) {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}
