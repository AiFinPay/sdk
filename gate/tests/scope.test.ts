import { describe, it, expect } from "vitest";
import { scopeCovers, patternCovers } from "../src/scope.js";

/**
 * These cases are written from the HOSTED gateway's behaviour, not from this
 * package's code. That direction is the whole point.
 *
 * src/scope.ts is a port of backend/aifp/scope.js. It was written 2026-08-20;
 * the hosted implementation was fixed 2026-08-27 (aifinpay-web 1173b93) and the
 * port did not follow. For eleven days a receipt bought for "/movies/*" opened
 * /movies/inception on the hosted gateway and was refused here — an agent paid
 * on-chain and got a 403 from the merchant who installed our middleware.
 *
 * A test written from this file's own behaviour would have passed throughout.
 * These assert what the hosted side does, so the port cannot drift again
 * without turning red.
 */
describe("scopeCovers — a wildcard resource covers the paths beneath it", () => {
  // The case that was broken. A merchant registers "/movies/*" as ONE resource;
  // the quote's resource is the pattern, not the URL the agent hit.
  it("opens a concrete path with a receipt bought for its wildcard", () => {
    expect(scopeCovers("exact", "/movies/*", "/movies/inception")).toBe(true);
    expect(scopeCovers("exact", "/genres/*", "/genres/action")).toBe(true);
    expect(scopeCovers("exact", "/collections/*", "/collections/best-2026")).toBe(true);
  });

  it("covers the section root as well as its children", () => {
    // A merchant who registers the wildcard means the section, not only what
    // hangs below it.
    expect(scopeCovers("exact", "/movies/*", "/movies")).toBe(true);
  });

  it("does not leak past the boundary", () => {
    // Without the slash, "/movies/*" would cover "/movies-internal".
    expect(scopeCovers("exact", "/movies/*", "/movies-internal")).toBe(false);
    expect(scopeCovers("exact", "/movies/*", "/moviesfoo")).toBe(false);
    expect(scopeCovers("exact", "/movies/*", "/other/inception")).toBe(false);
  });

  it("still matches a literal resource literally", () => {
    expect(scopeCovers("exact", "/about-us", "/about-us")).toBe(true);
    expect(scopeCovers("exact", "/about-us", "/about-us/team")).toBe(false);
    // Carried over from the original case table.
    expect(scopeCovers("exact", "/api/search", "/api/search")).toBe(true);
    expect(scopeCovers("exact", "/api/search", "/api/search/deep")).toBe(false);
    expect(scopeCovers(undefined, "/api/search", "/api/search")).toBe(true);
    expect(scopeCovers("wat", "/api/search", "/api/searchx")).toBe(false);
  });

  it("treats an unrecognised scope as exact rather than as permission", () => {
    expect(scopeCovers("something-new", "/about-us", "/about-us")).toBe(true);
    expect(scopeCovers("something-new", "/about-us", "/elsewhere")).toBe(false);
    expect(scopeCovers(undefined, "/about-us", "/elsewhere")).toBe(false);
  });
});

describe("scopeCovers — prefix and merchant are unchanged", () => {
  it("prefix covers the path and everything beneath, and stops at the boundary", () => {
    expect(scopeCovers("prefix", "/articles", "/articles")).toBe(true);
    expect(scopeCovers("prefix", "/articles", "/articles/2026/x")).toBe(true);
    // The trailing slash is the point: /articles must not cover
    // /articles-internal, or private routes are served on a blog receipt.
    expect(scopeCovers("prefix", "/articles", "/articles-internal")).toBe(false);
  });

  it("prefix / is the whole site", () => {
    expect(scopeCovers("prefix", "/", "/anything/at/all")).toBe(true);
  });

  it("prefix accepts a resource that already ends in a slash", () => {
    expect(scopeCovers("prefix", "/articles/", "/articles/2026/x")).toBe(true);
  });

  it("prefix does not let a numeric sibling through", () => {
    // /api/v1 must not cover /api/v10/secret. Carried over from the original
    // case table — it is the sharpest version of the boundary rule.
    expect(scopeCovers("prefix", "/api/v1", "/api/v10/secret")).toBe(false);
  });

  it("merchant covers everything, whatever the resource says", () => {
    expect(scopeCovers("merchant", "/whatever", "/anything")).toBe(true);
    // The receipt spells a merchant-wide resource as "*".
    expect(scopeCovers("merchant", "*", "/whatever")).toBe(true);
    expect(scopeCovers("merchant", "/ignored", "/whatever")).toBe(true);
  });
});

describe("patternCovers", () => {
  it("is exported so a caller can ask the question directly", () => {
    expect(patternCovers("/movies/*", "/movies/inception")).toBe(true);
    expect(patternCovers("/movies", "/movies/inception")).toBe(false);
  });

  it("survives a missing pattern rather than throwing into a request", () => {
    expect(patternCovers(undefined as unknown as string, "/x")).toBe(false);
    expect(patternCovers("", "")).toBe(true);
  });
});
