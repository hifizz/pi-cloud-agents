// Integrations extension wiring (AMP13-integrations, revised).
// The static extension (`tarsbot.integrations`: load_skill + the integrations system section) reads the
// workspace install store through the service injected by setIntegrationsService — the same resolver
// pattern as Exec, so tests can install their own service. Before wiring, no skills or MCP installs are
// visible anywhere (never a global fallback).
import { createIntegrationsExtension } from "../integrations.mjs";

let currentService;

/** Install the workspace integrations service (server: after registry + control store exist). */
export function setIntegrationsService(service) {
  currentService = service ?? undefined;
}

export function getIntegrationsService() {
  return currentService;
}

const facade = {
  installsForConversation: (conversationId) => (currentService ? currentService.installsForConversation(conversationId) : []),
  skillSnapshot: (id) => (currentService ? currentService.skillSnapshot(id) : undefined),
};

export const Integrations = createIntegrationsExtension(facade);
