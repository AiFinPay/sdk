// Directory profile end to end: the real @aifinpay/mcp (file:../mcp — run
// `npm ci && npm run build` in mcp/ first) behind this transport, exactly as
// mcp-http-directory.service runs it. Nothing here reaches the network: only
// initialize, tools/list and the toolspec are exercised, none of which call
// the API.
import { describe, expect, it } from "vitest";
import request from "supertest";

process.env.AIFINPAY_MCP_PROFILE = "directory";
process.env.MCP_PUBLIC_URL = "https://mcp.aifinpay.io/directory/mcp";
// The directory unit never sets this, but the profile must stay anonymous even if it did.
process.env.AIFINPAY_AUTH_REQUIRED = "true";

const { app } = await import("../server.js");

const DIRECTORY_TOOLS = [
  "agent_profile",
  "leaderboard",
  "list_providers",
  "network_stats",
  "provider_info",
  "provider_status",
  "quote_cost",
  "service_coverage",
  "verify_passport",
];

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

// Streamable HTTP answers a POST as an SSE stream; take the JSON-RPC message out of it.
function rpcBody(res: request.Response) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const data = res.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("");
  return JSON.parse(data);
}

describe("AIFINPAY_MCP_PROFILE=directory", () => {
  it("serves exactly the nine read-only tools over MCP, with no token", async () => {
    const init = await request(app)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
    expect(init.status).toBe(200);
    expect(rpcBody(init).result.serverInfo.name).toBe("@aifinpay/mcp-directory");
    const sessionId = init.headers["mcp-session-id"];
    expect(sessionId).toBeTruthy();

    const list = await request(app)
      .post("/mcp")
      .set(MCP_HEADERS)
      .set("mcp-session-id", sessionId)
      .set("mcp-protocol-version", "2025-06-18")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    const tools = rpcBody(list).result.tools;
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(DIRECTORY_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it("lists the same tools in the static toolspec", async () => {
    const res = await request(app).get("/toolspec.json");
    expect(res.status).toBe(200);
    expect(res.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(DIRECTORY_TOOLS);
  });
});
