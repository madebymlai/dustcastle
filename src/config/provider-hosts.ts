/**
 * The curated pi-provider → model-API-host table for Agent Egress (ADR 0010).
 *
 * This is the single, hand-maintained data file the egress allowlist draws the
 * agent's model endpoint from — the same per-provider curation ADR 0005 already
 * accepts for package registries. pi surfaces provider *names* (`pi --list-models`)
 * but never their API endpoints, so this map is the only place a host can come
 * from. Keys are pi's provider identifiers (the part before the first `/` in a
 * `provider/model` selector); values are every API host that provider may contact,
 * because a single run can't know which variant a provider will hit (auth refresh,
 * regional endpoint, legacy alias), and allowlisting all of a provider's own hosts
 * is still scoped — "the endpoints it was going to anyway."
 *
 * Hosts were read from the pi package's own provider definitions, not guessed.
 *
 * Two providers are intentionally absent because their host is configured
 * per-resource / per-region and cannot be a fixed value:
 *   - azure-openai  → `<resource>.openai.azure.com`        (AZURE_OPENAI_BASE_URL)
 *   - amazon-bedrock → `bedrock-runtime.<region>.amazonaws.com` (AWS_REGION)
 * A user on those providers hits {@link modelProviderHosts}'s actionable throw,
 * which is the right signal: dustcastle can't derive the host, so it must be told.
 */
export const PROVIDER_API_HOSTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["api.anthropic.com"],
  openai: ["api.openai.com"],
  // The Codex backend serves inference from chatgpt.com and refreshes its OAuth
  // token against auth.openai.com mid-session.
  "openai-codex": ["chatgpt.com", "auth.openai.com"],
  deepseek: ["api.deepseek.com"],
  gemini: ["generativelanguage.googleapis.com"],
  groq: ["api.groq.com"],
  cerebras: ["api.cerebras.ai"],
  xai: ["api.x.ai"],
  fireworks: ["api.fireworks.ai"],
  // together.ai is current; together.xyz is the still-served legacy host.
  together: ["api.together.ai", "api.together.xyz"],
  openrouter: ["openrouter.ai"],
  "ai-gateway": ["ai-gateway.vercel.sh"],
  zai: ["api.z.ai"],
  mistral: ["api.mistral.ai"],
  minimax: ["api.minimaxi.com"],
  // International (.ai) and China (.cn) endpoints.
  moonshot: ["api.moonshot.ai", "api.moonshot.cn"],
  opencode: ["opencode.ai"],
  kimi: ["api.kimi.com"],
  // Workers AI and the AI Gateway are distinct hosts under one provider.
  cloudflare: ["api.cloudflare.com", "gateway.ai.cloudflare.com"],
  // Global + the three regional Token-Plan endpoints (CN / Amsterdam / Singapore).
  xiaomi: [
    "api.xiaomimimo.com",
    "platform.xiaomimimo.com",
    "token-plan-cn.xiaomimimo.com",
    "token-plan-ams.xiaomimimo.com",
    "token-plan-sgp.xiaomimimo.com",
  ],
  // The OpenAI-compatible inference router (model ids carry their own `/`).
  huggingface: ["router.huggingface.co"],
};
