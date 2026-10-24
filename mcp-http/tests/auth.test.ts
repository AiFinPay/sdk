// Bearer gate with the audience allowlist, as mcp-http.service runs it:
// AIFINPAY_AUTH_REQUIRED=true and AIFINPAY_OAUTH_AUDIENCE a comma list. The IdP
// is a local JWKS server; tokens are signed here.
import { vi, describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

vi.mock("@aifinpay/mcp", () => ({
  createServer: vi.fn(async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const server = new Server({ name: "mock", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    return { server, agent: { address: "MockAddr" } };
  }),
  createDirectoryServer: vi.fn(async () => {
    throw new Error("the connector profile must not build the directory server");
  }),
}));

const RESOURCE = "https://mcp.example.test/mcp";
const PROJECT_ID = "project-test-1234";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
const { privateKey: strangerKey } = await generateKeyPair("RS256");

let idp: http.Server;
let issuer: string;
let app: import("express").Express;

beforeAll(async () => {
  idp = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  process.env.AIFINPAY_AUTH_REQUIRED = "true";
  process.env.AIFINPAY_OAUTH_ISSUER = issuer;
  process.env.MCP_RESOURCE_URL = RESOURCE;
  process.env.AIFINPAY_OAUTH_AUDIENCE = ` ${PROJECT_ID} , ${RESOURCE} `;
  ({ app } = await import("../server.js"));
});

afterAll(async () => {
  await new Promise((resolve) => idp.close(resolve));
});

async function token(claims: { aud?: string | string[]; iss?: string }, key = privateKey) {
  const jwt = new SignJWT({ scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(claims.iss ?? issuer)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m");
  if (claims.aud !== undefined) jwt.setAudience(claims.aud);
  return jwt.sign(key);
}

function initialize(bearer?: string) {
  const req = request(app)
    .post("/mcp")
    .set("content-type", "application/json")
    .set("accept", "application/json, text/event-stream");
  if (bearer) req.set("authorization", `Bearer ${bearer}`);
  return req.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
}

function expectChallenge(res: request.Response, reason: string) {
  expect(res.status).toBe(401);
  expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
  expect(res.body.error.message).toContain(reason);
}

describe("bearer gate with AIFINPAY_OAUTH_AUDIENCE", () => {
  it("challenges a request with no token", async () => {
    expectChallenge(await initialize(), "OAuth required");
  });

  it("rejects a valid signature whose aud is outside the list", async () => {
    expectChallenge(await initialize(await token({ aud: "some-other-project" })), "invalid_token");
  });

  it("rejects a token with no aud", async () => {
    expectChallenge(await initialize(await token({})), "invalid_token");
  });

  it("rejects an aud array with no listed member", async () => {
    expectChallenge(await initialize(await token({ aud: ["a", "https://mcp.example.test/other"] })), "invalid_token");
  });

  it("rejects a listed aud signed by a key outside the IdP's JWKS", async () => {
    expectChallenge(await initialize(await token({ aud: PROJECT_ID }, strangerKey)), "invalid_token");
  });

  it("rejects a listed aud from another issuer", async () => {
    expectChallenge(await initialize(await token({ aud: PROJECT_ID, iss: "https://evil.example.test" })), "invalid_token");
  });

  it("accepts the IdP project id (first list entry, whitespace trimmed)", async () => {
    const res = await initialize(await token({ aud: PROJECT_ID }));
    expect(res.status).toBe(200);
  });

  it("accepts the resource URL (second list entry)", async () => {
    const res = await initialize(await token({ aud: RESOURCE }));
    expect(res.status).toBe(200);
  });

  it("accepts an aud array containing a listed entry", async () => {
    const res = await initialize(await token({ aud: ["client-abc", PROJECT_ID] }));
    expect(res.status).toBe(200);
  });

  it("advertises the standard OIDC scopes by default", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource");
    expect(res.body.resource).toBe(RESOURCE);
    expect(res.body.authorization_servers).toEqual([issuer]);
    expect(res.body.scopes_supported).toEqual(["openid", "profile", "email", "offline_access"]);
  });
});
