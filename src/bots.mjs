// Bot registry: bots.json maps a Bot to its durable conversation and display config.
// A Bot = one ownerless Conversation + its pi.agent configuration (REQ-ARC-2).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config, defaultModel } from "./config.mjs";
import { ctx } from "./harness.mjs";

/** Tools a read-only fork (REQ-F07) may keep, by name. */
export const READ_ONLY_TOOLS = ["read", "web_search", "search_history"];

export class BotRegistry {
  /** @param {any} harness @param {{ path?: string|null }} [opts] path=null keeps the registry in memory */
  constructor(harness, opts = {}) {
    this.harness = harness;
    this.path = opts.path === undefined ? config.botsPath : opts.path;
    this.bots = this.#load();
  }

  #load() {
    if (!this.path || !existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, "utf8")).bots ?? [];
  }

  #save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bots: this.bots }, null, 2));
    renameSync(tmp, this.path);
  }

  list() {
    return [...this.bots];
  }

  get(id) {
    return this.bots.find((b) => b.id === id || b.name === id);
  }

  /** Durable conversation handle for a Bot. */
  async conversation(id) {
    const bot = this.get(id);
    if (!bot) return undefined;
    return this.harness.conversation(bot.conversationId, ctx);
  }

  /**
   * `workspaceId` is a stable marker for the workspace service: a Bot created but not yet linked (crash in between) is found
   * again by it, never by comparing instruction text.
   * @param {{ name: string, model?: {provider:string, modelId:string}, instructions?: string, thinkingLevel?: string, cwd?: string, workspaceId?: string, extensions?: any[], tools?: any[] }} spec
   */
  async createBot(spec) {
    if (!spec?.name) throw new Error("name is required");
    if (this.get(spec.name)) throw new Error(`bot exists: ${spec.name}`);
    const agent = {
      model: spec.model ?? defaultModel(),
      ...(spec.instructions ? { instructions: spec.instructions } : {}),
      ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.extensions ? { extensions: spec.extensions } : {}),
      ...(spec.tools ? { tools: spec.tools } : {}),
    };
    const conv = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
    const bot = {
      id: randomUUID().slice(0, 8),
      name: spec.name,
      conversationId: conv.id,
      model: agent.model,
      instructions: spec.instructions ?? "",
      ...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.bots.push(bot);
    this.#save();
    return bot;
  }

  /**
   * Hand a Bot's history to a new Bot: fork the parent conversation at `entryId` (default: newest entry) into a new
   * ownerless conversation. The fork inherits the parent's agent (asOf copy); `readOnly` narrows its tools to
   * READ_ONLY_TOOLS (resolved to tool objects via the parent's agent, so no registry access is needed).
   * @param {string} fromIdOrName
   * @param {{ entryId?: string, name: string, modelId?: string, readOnly?: boolean, instructions?: string }} spec
   */
  async forkBot(fromIdOrName, spec) {
    if (!spec?.name) throw new Error("name is required");
    const parent = this.get(fromIdOrName);
    if (!parent) throw new Error(`bot not found: ${fromIdOrName}`);
    if (this.get(spec.name)) throw new Error(`bot exists: ${spec.name}`);
    const conv = await this.conversation(parent.id);
    if (!conv) throw new Error(`conversation not found for bot: ${parent.name}`);

    let entryId = spec.entryId;
    if (!entryId) {
      const newest = await conv.entries({}, 1, undefined, ctx);
      entryId = newest.items[0]?.id;
      if (!entryId) throw new Error(`bot has no history to fork: ${parent.name}`);
    }

    const agent = {};
    if (spec.modelId) agent.model = { provider: parent.model?.provider ?? defaultModel().provider, modelId: spec.modelId };
    if (spec.instructions) agent.instructions = spec.instructions;
    if (spec.readOnly) {
      const resolved = await conv.agent(ctx);
      agent.tools = resolved.tools.filter((t) => READ_ONLY_TOOLS.includes(t.name));
    }

    const child = await conv.fork(entryId, { ownership: { kind: "ownerless" }, agent }, ctx);
    const bot = {
      id: randomUUID().slice(0, 8),
      name: spec.name,
      conversationId: child.id,
      model: agent.model ?? parent.model,
      instructions: spec.instructions ?? parent.instructions ?? "",
      createdAt: new Date().toISOString(),
      parent: { botId: parent.id, entryId },
      ...(spec.readOnly ? { readOnly: true } : {}),
    };
    this.bots.push(bot);
    this.#save();
    return bot;
  }

  /** Record an already-created conversation (e.g. a fork) as a Bot. */
  register(bot) {
    this.bots.push(bot);
    this.#save();
    return bot;
  }
}
