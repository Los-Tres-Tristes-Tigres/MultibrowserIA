const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_FREE_MODEL = "openrouter/free";

export type SearchHit = {
  title: string;
  url: string;
  highlights: string[];
};

export async function searchWeb(
  query: string,
  numResults = 5,
): Promise<SearchHit[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("Missing EXA_API_KEY");

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults,
      contents: { highlights: true },
    }),
  });

  if (!response.ok) {
    throw new Error(`Exa ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; highlights?: string[] }>;
  };

  return (data.results ?? []).map((result) => ({
    title: result.title ?? "Untitled",
    url: result.url ?? "",
    highlights: result.highlights ?? [],
  }));
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return "No web results found.";
  return hits
    .map((hit, index) => {
      const excerpts = hit.highlights
        .slice(0, 2)
        .map((text) => (text.length > 280 ? `${text.slice(0, 280)}…` : text))
        .join(" ")
        .trim();
      return `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${excerpts}`;
    })
    .join("\n\n");
}

export async function research(
  question: string,
  threadContext = "",
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const hits = await searchWeb(question);
  const sources = formatHits(hits);
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "Tigre Orbit",
    },
    body: JSON.stringify({
      model: OPENROUTER_FREE_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are Tigre. Answer using only the web sources. Be concise. Use bullets. Cite URLs. Match the question language.",
        },
        {
          role: "user",
          content: [
            threadContext ? `Slack thread:\n${threadContext}\n` : "",
            `Question: ${question}`,
            "",
            "Web sources:",
            sources,
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Tigre returned an empty answer");
  return content;
}

export async function postToSlack(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ channel: string; ts: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN");

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text: text.slice(0, 3500),
      thread_ts: threadTs,
    }),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  };

  if (!data.ok || !data.channel || !data.ts) {
    throw new Error(data.error || "Slack chat.postMessage failed");
  }

  return { channel: data.channel, ts: data.ts };
}
