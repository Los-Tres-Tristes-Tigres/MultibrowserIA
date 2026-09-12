import { createHash } from "node:crypto";
import type { BrowserAction } from "../shared/types.js";
import type { AgentStep } from "./providers.js";

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
  html: string;
  formState: string;
}
const externalWords =
  /\b(send|submit|save|create|delete|remove|purchase|buy|pay|checkout|publish|post|invite|confirm|accept|approve|unsubscribe|archive|trash|upload|enviar|guardar|crear|eliminar|borrar|comprar|pagar|publicar|invitar|confirmar|aceptar|archivar)\b/i;
const dangerousUrl =
  /(?:logout|signout|delete|remove|unsubscribe|archive|purchase|checkout|submit|send|confirm|invite|\/save)(?:[/?#=&_-]|$)/i;

export function requiresApproval(
  step: Pick<AgentStep, "impact" | "instruction">,
  action: BrowserAction,
  target: TargetEvidence,
) {
  // The model can request stricter policy, never waive it. Inspect the actual target.
  if (step.impact === "external" || step.impact === "uncertain") return true;
  const intent = `${target.label} ${target.text} ${action.description} ${step.instruction}`;
  if (externalWords.test(intent) || dangerousUrl.test(target.href)) return true;
  if (["scrollTo", "scrollIntoView", "hover"].includes(action.method))
    return false;
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
    !target.editable
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
