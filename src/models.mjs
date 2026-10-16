// Model layer: an OpenAI-compatible "TokenRouter" provider for pi-ai.
// Base URL and API key come from TOKEN_ROUTER_BASE_URL / TOKEN_ROUTER_API_KEY.
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { config } from "./config.mjs";

// Models we use. Costs are per 1M tokens (USD); approximate values used only for
// usage reporting, adjust when real router prices are known.
const MODEL_SPECS = [
  // Router price for swe-2 is unknown; 0 keeps usage reporting honest (tokens counted, no cost).
  { id: "swe-2", name: "SWE-2", reasoning: true, input: ["text"], cost: { input: 0, output: 0 } },
  { id: "glm-5.3", name: "GLM-5.3", reasoning: true, input: ["text"], cost: { input: 0.6, output: 2.2 } },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", reasoning: true, input: ["text"], cost: { input: 0.1, output: 0.4 } },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15 } },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 8 } },
];

function baseUrl() {
  const url = process.env.TOKEN_ROUTER_BASE_URL;
  if (!url) throw new Error("TOKEN_ROUTER_BASE_URL is not set");
  return url.replace(/\/+$/, "");
}

export function tokenRouterProvider(extraModelIds = []) {
  const url = baseUrl();
  const specs = [...MODEL_SPECS];
  for (const id of extraModelIds) {
    if (!specs.some((s) => s.id === id)) specs.push({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0 } });
  }
  const models = specs.map((s) => ({
    id: s.id,
    name: s.name,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: url,
    reasoning: s.reasoning,
    input: s.input,
    cost: { input: s.cost.input, output: s.cost.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
  }));
  return createProvider({
    id: config.provider,
    name: "TokenRouter",
    baseUrl: url,
    auth: { apiKey: envApiKeyAuth("TokenRouter API key", ["TOKEN_ROUTER_API_KEY"]) },
    models,
    api: openAICompletionsApi(),
  });
}

export function createTarsModels() {
  const models = createModels();
  models.setProvider(tokenRouterProvider([config.defaultModelId]));
  return models;
}
