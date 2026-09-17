import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Mock @aifinpay/mcp before importing the server, so buildToolspec works.
// We create a real MCP Server with a tools/list handler to exercise the
// InMemoryTransport + Client path in buildToolspec.
const MOCK_TOOLS = [
  { name: "agent_address", description: "Show address", inputSchema: { type: "object", properties: {} } },
  { name: "agent_quota",   description: "Show quota",   inputSchema: { type: "object", properties: {} } },
];

vi.mock("@aifinpay/mcp", () => ({
  createServer: vi.fn(async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const server = new Server({ name: "mock", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MOCK_TOOLS }));
    return { server, agent: { solanaAddress: "MockSol", evmAddress: "0xMock", address: "MockAddr" } };
  }),
}));

const { app } = await import("../server.js");

describe("GET /", () => {
  it("returns catalog metadata", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.server).toBe("@aifinpay/mcp-http");
    expect(res.body.protocol).toBe("Model Context Protocol");
    expect(res.body.transport).toBe("Streamable HTTP");
    expect(res.body.mcp_endpoint).toContain("/mcp");
    expect(res.body.description).toBeTruthy();
    expect(res.body.install).toBeDefined();
    expect(res.body.install.http.method).toBe("POST");
    expect(res.body.tools).toBeInstanceOf(Array);
    expect(res.body.tools.length).toBeGreaterThan(0);
    expect(res.body.links).toBeDefined();
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns RFC 9728 metadata", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBeTruthy();
    expect(res.body.authorization_servers).toBeInstanceOf(Array);
    expect(res.body.scopes_supported).toBeInstanceOf(Array);
    expect(res.body.bearer_methods_supported).toContain("header");
  });

  it("sets cache-control header", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource");
    expect(res.headers["cache-control"]).toContain("max-age=3600");
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("returns 404 when no issuer configured", async () => {
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_authorization_server_configured");
  });
});

describe("GET /toolspec.json", () => {
  it("returns wrapped format by default", async () => {
    const res = await request(app).get("/toolspec.json");
    expect(res.status).toBe(200);
    expect(res.body.tools).toBeInstanceOf(Array);
    expect(res.body.tools.length).toBeGreaterThan(0);
    expect(res.body.tools[0].name).toBeTruthy();
    expect(res.body.tools[0].description).toBeTruthy();
  });

  it("returns bare format when variant=bare", async () => {
    const res = await request(app).get("/toolspec.json?variant=bare");
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("returns vertex format when variant=vertex", async () => {
    const res = await request(app).get("/toolspec.json?variant=vertex");
    expect(res.status).toBe(200);
    expect(res.body.interfaces).toBeInstanceOf(Array);
    expect(res.body.interfaces.length).toBe(1);
    expect(res.body.interfaces[0].protocolBinding).toBe("MCP");
    expect(res.body.interfaces[0].tools).toBeInstanceOf(Array);
  });

  it("sets cache-control header", async () => {
    const res = await request(app).get("/toolspec.json");
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });
});

describe("POST /mcp", () => {
  it("returns toolspec for empty body without session (treated as crawler)", async () => {
    const res = await request(app).post("/mcp").send({});
    expect(res.status).toBe(200);
    expect(res.body.server).toBe("@aifinpay/mcp-http");
    expect(res.body.tools).toBeInstanceOf(Array);
  });

  it("returns 400 for non-initialize body without session", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("user-agent", "test-client/1.0")
      .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.error.code).toBe(-32600);
  });

  it("returns toolspec for crawler user-agent with empty body", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("user-agent", "Google-Cloud-Vertex")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.server).toBe("@aifinpay/mcp-http");
    expect(res.body.tools).toBeInstanceOf(Array);
  });

  it("returns toolspec for bot user-agent with empty body", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("user-agent", "SomeBot/1.0")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.tools).toBeInstanceOf(Array);
  });
});

describe("GET /mcp", () => {
  it("returns toolspec when no session id", async () => {
    const res = await request(app).get("/mcp");
    expect(res.status).toBe(200);
    expect(res.body.server).toBe("@aifinpay/mcp-http");
    expect(res.body.tools).toBeInstanceOf(Array);
    expect(res.body.tools.length).toBeGreaterThan(0);
  });

  it("sets cache-control header", async () => {
    const res = await request(app).get("/mcp");
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });
});

describe("DELETE /mcp", () => {
  it("returns 400 without session id", async () => {
    const res = await request(app).delete("/mcp");
    expect(res.status).toBe(400);
  });
});
