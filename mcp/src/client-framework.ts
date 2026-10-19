import type { AgentFramework } from "@aifinpay/agent";

/**
 * MCP `clientInfo.name`, as the client sent it at initialize, → the
 * AIFP-Agent-Framework the backend records. Exact names only: a client not
 * listed here sends no header rather than a guess. Entries are the names the
 * product owner listed plus `cursor-vscode`, which Cursor is reported to send,
 * and `codex-mcp-client`, which Codex sends (openai/codex
 * codex-rs/codex-mcp/src/rmcp_client.rs, `Implementation::new("codex-mcp-client", …)`);
 * confirm new ones against real initialize payloads before adding them. The
 * server logs every client's name at initialize so an unlisted one is visible.
 */
const CLIENT_FRAMEWORKS = new Map<string, AgentFramework>([
  ["claude-ai", "claude"],
  ["claude-code", "claude"],
  ["cursor", "cursor"],
  ["cursor-vscode", "cursor"],
  ["windsurf", "windsurf"],
  ["chatgpt", "chatgpt"],
  ["openai", "chatgpt"],
  ["codex-mcp-client", "codex"],
  ["gemini", "gemini"],
  ["perplexity", "perplexity"],
]);

export function frameworkForClient(name: unknown): AgentFramework | undefined {
  return typeof name === "string" ? CLIENT_FRAMEWORKS.get(name) : undefined;
}

/**
 * One stderr line per connection, so a client the table does not know shows up
 * in the server log instead of silently sending no header. The name is the
 * client's own public identifier, never a secret.
 */
export function clientFrameworkLine(name: unknown): string {
  const client = typeof name === "string" ? JSON.stringify(name) : "(unnamed)";
  return `[aifinpay-mcp] client ${client} → framework ${frameworkForClient(name) ?? "none"}`;
}
