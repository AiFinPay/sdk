// ──────────────────────────────────────────────────────────────────────────
// @aifinpay/gate/edge — the part of the gate with no dependencies at all.
//
// For runtimes without Node built-ins: a Cloudflare Worker, a log shipper, a
// Deno or Bun edge function. Who asked (classifyAgent, from the same marker
// table the gate charges from), which registered pattern a path belongs to
// (matchResource) and what a receipt's scope covers (scopeCovers). No jose,
// no express, no node:crypto — nothing here verifies a receipt or meters a
// unit; it only answers the questions an observe-only installation asks.
// ──────────────────────────────────────────────────────────────────────────
export {
  classifyAgent,
  knownAiAgent,
  AI_AGENT_UA_MARKERS,
  AI_AGENT_UA_TABLE,
  GATE_OPERATORS,
  UA_CLASSES,
} from "./agents.js";
export type { AgentIdentity, AiAgentUaEntry, GateOperator, UaClass } from "./agents.js";
export { matchResource } from "./match.js";
export { scopeCovers } from "./scope.js";
export type { AifpResource, GateMode, GateRequest } from "./types.js";
