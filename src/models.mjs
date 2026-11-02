// Model layer: an OpenAI-compatible "TokenRouter" provider for pi-ai.
// Base URL and API key come from TOKEN_ROUTER_BASE_URL / TOKEN_ROUTER_API_KEY.
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { config } from "./config.mjs";

// Per-model thinking levels selectable over the current wire protocol (openai-completions → `reasoning_effort`).
// Only swe-2 has evidence for this gateway today: the thread-chatbot capability table
// (any-staff/constants/models/token-router.ts sweCapabilities) plus its wire test prove medium/high/max pass
// through verbatim. Other catalog models keep `supportsReasoningEffort: false` so this change does not alter
// their existing request shape — they send no reasoning_effort and the selector renders disabled for them.
const THINKING_LEVELS_SWE2 = ["medium", "high", "max"];
const ALL_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** pi-ai thinkingLevelMap: listed levels pass through verbatim; every other level is marked unsupported. */
const thinkingMap = (levels) => Object.fromEntries(ALL_THINKING_LEVELS.map((l) => [l, levels.includes(l) ? l : null]));
const MODEL_SPECS = [
  // Router price for swe-2 is unknown; 0 keeps usage reporting honest (tokens counted, no cost).
  // TokenRouter declares imageInput for SWE-2 (same catalog used by thread-chatbot): pixels reach the model.
  { id: "swe-2", name: "SWE-2", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0 }, thinkingLevels: THINKING_LEVELS_SWE2 },
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

/** Whitelisted model ids a session may switch to (PATCH /api/bots/:id/model). */
export function availableModelIds() {
  return MODEL_SPECS.map((s) => s.id);
}

/** Whether a model id accepts image input (MODEL_SPECS is the single source). Unknown ids: text-only. */
export function acceptsImageInput(modelId) {
  return MODEL_SPECS.some((s) => s.id === modelId && s.input.includes("image"));
}

function thinkingMapFor(modelId) {
  const levels = MODEL_SPECS.find((s) => s.id === modelId)?.thinkingLevels;
  return levels ? thinkingMap(levels) : undefined;
}

/**
 * Selectable thinking levels for a model over the current wire protocol. Unknown ids, non-catalog ids and
 * models without verified support return [] so the UI offers a disabled selector rather than a fake menu.
 * Derived through pi-ai's own support rule so the list can never drift from what the SDK will honor.
 */
export function supportedThinkingLevels(modelId) {
  const map = thinkingMapFor(modelId);
  if (!map) return [];
  return getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map }).filter((l) => l !== "off");
}

/**
 * Deterministic fallback when a stored level is not selectable on a model (model switch, older record,
 * fork at an older entry): the stored level when supported, else the nearest higher supported level, else
 * the highest one below it — the same climb-up-first order pi-ai's own clamp uses — else undefined when the
 * model takes no level. `preferred` of "off"/absent returns undefined: provider default means no
 * reasoning_effort is sent and is never silently upgraded on model switch.
 */
export function defaultThinkingLevel(modelId, preferred) {
  const supported = supportedThinkingLevels(modelId);
  if (supported.length === 0 || !preferred || preferred === "off") return undefined;
  const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
  if (supported.includes(preferred)) return preferred;
  const idx = ORDER.indexOf(preferred);
  if (idx === -1) return undefined;
  for (let i = idx; i < ORDER.length; i++) if (supported.includes(ORDER[i])) return ORDER[i];
  return supported.at(-1);
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
    compat: {
      supportsDeveloperRole: false,
      // Only models with a verified thinking-level list get reasoning_effort on the wire; everything else
      // (incl. extraModelIds, which have no capability evidence) keeps the previous request shape.
      supportsReasoningEffort: Boolean(s.thinkingLevels),
      supportsStore: false,
    },
    ...(s.thinkingLevels ? { thinkingLevelMap: thinkingMap(s.thinkingLevels) } : {}),
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
