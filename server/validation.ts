import { z } from "zod";
import type { AgentConnection, BrowserAgentRecord } from "../shared/types.js";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/);
export const webUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Enter an http:// or https:// URL without credentials.");
export const providerSchema = z
  .object({
    provider: z.enum(["openai", "openrouter", "gemini"]),
    model: z.string().trim().min(1).max(160),
  })
  .strict();
export const agentInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    url: webUrl,
    preset: z.string().max(30).default("custom"),
    provider: providerSchema,
    instructions: z.string().max(8000).default(""),
    position: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .optional(),
  })
  .strict();
export const connectionInput = z
  .object({
    source: idSchema,
    target: idSchema,
    instruction: z.string().max(8000).default(""),
  })
  .strict();

export function validateConnections(
  agents: Pick<BrowserAgentRecord, "id">[],
  edges: AgentConnection[],
) {
  const ids = new Set(agents.map((a) => a.id));
  const outgoing = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target))
      throw new AppError("Connection refers to a missing agent.");
    if (edge.source === edge.target)
      throw new AppError("An agent cannot connect to itself.");
    if (outgoing.has(edge.source) || incoming.has(edge.target))
      throw new AppError(
        "P0 workflows are linear: one incoming and one outgoing connection per agent.",
      );
    outgoing.set(edge.source, edge.target);
    incoming.add(edge.target);
  }
  for (const start of outgoing.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current) {
      if (visited.has(current))
        throw new AppError("Workflows cannot contain cycles.");
      visited.add(current);
      current = outgoing.get(current);
    }
  }
}

export function linearPath(
  agents: BrowserAgentRecord[],
  edges: AgentConnection[],
  start: string,
) {
  validateConnections(agents, edges);
  if (!agents.some((a) => a.id === start))
    throw new AppError("Starting agent no longer exists.");
  const result = [start];
  let next: AgentConnection | undefined;
  while ((next = edges.find((e) => e.source === result.at(-1))))
    result.push(next.target);
  return result;
}

export function publicError(error: unknown) {
  let message = error instanceof Error ? error.message : "Unexpected error";
  for (const name of [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
  ]) {
    const key = process.env[name]?.trim();
    if (key && key.length >= 8) message = message.split(key).join("[redacted]");
  }
  return message
    .replace(/sk-[\w-]+/g, "[redacted]")
    .replace(/AIza[\w-]{35}/g, "[redacted]")
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]")
    .replace(
      /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .slice(0, 1200);
}

/** Model output for handoffs and extraction. Malformed JSON is kept as text instead of failing a run. */
export function structuredData(value: string): Record<string, unknown> {
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")
    .trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return { text: text.slice(0, 8000) };
  }
}
