export default {
  id: "freebuff",
  priority: 210,
  hasFree: true,
  alias: "freebuff",
  aliases: ["codebuff-free"],
  uiAlias: "freebuff",
  display: {
    name: "Codebuff Freebuff",
    icon: "bolt",
    color: "#FF6B35",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      text: "Freebuff free tier (Codebuff framework): GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo, Solar Mini 4 — several unmetered. Needs a Freebuff token from the dashboard, or an existing `manicode login` credentials file.",
      apiKeyUrl: "https://freebuff.com",
    },
  },
  category: "free",
  authModes: ["apikey"],
  authHint:
    "Paste your Freebuff auth token (freebuff.com dashboard), or paste the `authToken` from ~/.config/manicode/credentials.json after running `manicode login`",
  transport: {
    baseUrl: "https://codebuff.com/api/v1/chat/completions",
    format: "openai",
    headers: {
      // SDK-shaped UA the upstream expects (see open-sse/executors/freebuff.js)
      "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  // Unmetered models first — they cost no free session.
  models: [
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash (Freebuff)" },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (Freebuff)" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5 (Freebuff)" },
    { id: "upstage/solar-mini4", name: "Solar Mini 4 (Freebuff)" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2 (Freebuff)" },
    { id: "z-ai/glm-5.3", name: "GLM 5.3 (Freebuff)" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (Freebuff)" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (Freebuff)" },
    { id: "deepseek/deepseek-v4.1-pro", name: "DeepSeek V4.1 Pro (Freebuff)" },
    { id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna (Freebuff)" },
    { id: "openai/gpt-6-luna", name: "GPT 6 Luna (Freebuff)" },
    { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco (Freebuff)" },
  ],
  passthroughModels: true,
  serviceKinds: ["llm"],
  features: {
    usage: false,
  },
};
