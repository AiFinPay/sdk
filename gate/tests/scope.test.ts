import { describe, expect, it } from "vitest";
import { scopeCovers } from "../src/index.js";

describe("scopeCovers", () => {
  it("exact covers only itself, and is what an unknown scope degrades to", () => {
    expect(scopeCovers("exact", "/api/search", "/api/search")).toBe(true);
    expect(scopeCovers("exact", "/api/search", "/api/search/deep")).toBe(false);
    expect(scopeCovers(undefined, "/api/search", "/api/search")).toBe(true);
    expect(scopeCovers("wat", "/api/search", "/api/searchx")).toBe(false);
  });

  it("prefix covers the path itself and everything beneath it", () => {
    expect(scopeCovers("prefix", "/articles/", "/articles/2026/x")).toBe(true);
    expect(scopeCovers("prefix", "/articles", "/articles")).toBe(true);
    expect(scopeCovers("prefix", "/articles", "/articles/2026/x")).toBe(true);
  });

  it("prefix does NOT cover a sibling that merely shares the leading string", () => {
    // The pair that justifies the trailing-slash boundary: without it, a
    // receipt bought for a public blog serves the merchant's internal routes.
    expect(scopeCovers("prefix", "/articles", "/articles-internal")).toBe(false);
    expect(scopeCovers("prefix", "/api/v1", "/api/v10/secret")).toBe(false);
  });

  it("prefix '/' is the whole site", () => {
    expect(scopeCovers("prefix", "/", "/anything/at/all")).toBe(true);
  });

  it("merchant covers everything, which is why the receipt spells its resource '*'", () => {
    expect(scopeCovers("merchant", "*", "/whatever")).toBe(true);
    expect(scopeCovers("merchant", "/ignored", "/whatever")).toBe(true);
  });
});
