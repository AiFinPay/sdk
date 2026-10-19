import type { AgentFramework } from "@aifinpay/agent";

/**
 * MCP `clientInfo.name`, as the client sent it at initialize, → the
 * AIFP-Agent-Framework the backend records. Exact names only: a client not
 * listed here sends no header rather than a guess. Entries are the names the
 * product owner listed plus `cursor-vscode`, which Cursor is reported to send;
 * confirm new ones against real initialize payloads before adding them.
 */
const CLIENT_FRAMEWORKS = new Map<string, AgentFramework>([
  ["claude-ai", "claude"],
  ["claude-code", "claude"],
  ["cursor", "cursor"],
  ["cursor-vscode", "cursor"],
  ["windsurf", "windsurf"],
  ["chatgpt", "chatgpt"],
  ["openai", "chatgpt"],
  ["gemini", "gemini"],
  ["perplexity", "perplexity"],
]);

export function frameworkForClient(name: unknown): AgentFramework | undefined {
  return typeof name === "string" ? CLIENT_FRAMEWORKS.get(name) : undefined;
}
