export const PRESETS = [
  { id: "gmail", name: "Gmail", url: "https://mail.google.com/" },
  { id: "calendar", name: "Calendar", url: "https://calendar.google.com/" },
  { id: "slack", name: "Slack", url: "https://app.slack.com/" },
  { id: "notion", name: "Notion", url: "https://www.notion.so/" },
  { id: "github", name: "GitHub", url: "https://github.com/" },
  { id: "outlook", name: "Outlook", url: "https://outlook.live.com/mail/" },
  { id: "custom", name: "Custom Website", url: "" },
] as const;
export const PROVIDERS = [
  {
    id: "openai" as const,
    name: "OpenAI",
    envName: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1",
  },
  {
    id: "openrouter" as const,
    name: "OpenRouter",
    envName: "OPENROUTER_API_KEY",
    defaultModel: "openrouter/free",
  },
  {
    id: "gemini" as const,
    name: "Gemini / AI Studio",
    envName: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
  },
];
