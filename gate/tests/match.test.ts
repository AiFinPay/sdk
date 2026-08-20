import { describe, expect, it } from "vitest";
import { matchResource } from "../src/index.js";
import type { AifpResource } from "../src/index.js";

const res = (route_pattern: string, extra: Partial<AifpResource> = {}): AifpResource => ({
  id: "res_" + route_pattern.replace(/\W/g, "").slice(0, 12).padEnd(12, "0"),
  route_pattern,
  type: "api",
  paywall_enabled: true,
  tier: "standard",
  unit_weight: null,
  name: null,
  created_at: "2026-08-20T00:00:00.000Z",
  ...extra,
});

describe("matchResource", () => {
  it("matches exact patterns exactly", () => {
    const list = [res("/api/search")];
    expect(matchResource(list, "/api/search")?.route_pattern).toBe("/api/search");
    expect(matchResource(list, "/api/search/x")).toBe(null);
  });

  it("'/api/*' matches '/api' itself as well as everything below it", () => {
    const list = [res("/api/*")];
    expect(matchResource(list, "/api")?.route_pattern).toBe("/api/*");
    expect(matchResource(list, "/api/deep/path")?.route_pattern).toBe("/api/*");
  });

  it("the longest pattern wins regardless of registration order", () => {
    // Registration order is Redis hash order, i.e. arbitrary. Specificity has
    // to come from the pattern, or a catch-all silently reprices a route the
    // merchant deliberately made expensive.
    const list = [res("/api/*"), res("/api/search", { unit_weight: 10 })];
    expect(matchResource(list, "/api/search")?.unit_weight).toBe(10);
    expect(matchResource([...list].reverse(), "/api/search")?.unit_weight).toBe(10);
  });

  it("returns null for an unregistered path — the caller must read that as paywalled", () => {
    expect(matchResource([res("/api/search")], "/nothing")).toBe(null);
  });
});
