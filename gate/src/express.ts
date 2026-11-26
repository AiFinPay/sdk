import type { NextFunction, Request, RequestHandler, Response } from "express";
import { CDN_CACHE_HEADERS, createGateOn, NO_STORE, refundUnits, type GateOptions } from "./core.js";
import { MemoryStore } from "./stores/memory.js";
import type { AifpContext } from "./types.js";
import { linkHtmlResponse } from "./discovery.js";
import { discoveryLinkHeader } from "./discovery-link.js";
import { validReportingContext, type ReportingContext, type ReportedEvent } from "./reporter.js";
import { chargeOf } from "./identity.js";
import { readsClientIp } from "./hosted-detect.js";

/**
 * `trust proxy: true` makes `req.ip` the left-most X-Forwarded-For entry,
 * which the client writes. `unprovenPays` and `hostedDetect` decide from
 * `req.ip` (a search crawler is verified by its address), so with it any
 * client sending a Googlebot User-Agent and a Google address in
 * X-Forwarded-For reads free. A hop count, "loopback" or the proxy's
 * addresses are safe; `true` is not.
 */
export const TRUST_PROXY_WARNING =
  "[@aifinpay/gate] shouldCharge reads req.ip, and Express `trust proxy` is true: req.ip then comes from " +
  "X-Forwarded-For, which the client controls, so a forged search-crawler address reads free. Set " +
  '`trust proxy` to your proxy (a hop count, "loopback" or its addresses).';

/** With `trust proxy` unset behind a proxy, every visitor has the proxy's address. */
export const PROXY_UNSET_WARNING =
  "[@aifinpay/gate] shouldCharge reads req.ip, the request was forwarded (X-Forwarded-For or CF-Connecting-IP) " +
  "and Express `trust proxy` is not set: req.ip is then your proxy's address for every visitor. Set " +
  '`trust proxy` to your proxy (a hop count, "loopback" or its addresses).';

// Several mounts sharing a response must never count its terminal event twice.
const reportingResponses = new WeakSet<Response>();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aifp?: AifpContext;
    }
  }
}

/** A handler that sets its own cache headers must not make a paid response storable. */
function keepPaidUnstored(res: Response): void {
  const writeHead = res.writeHead;
  const dropped = (name: unknown) => {
    const lower = String(name).toLowerCase();
    return lower === "cache-control" || CDN_CACHE_HEADERS.includes(lower);
  };
  res.writeHead = function (this: Response, ...args: unknown[]) {
    const kept = args.map((arg) => {
      if (Array.isArray(arg)) {
        // Node takes the flat [name, value, name, value], and pairs reach here too.
        if (Array.isArray(arg[0])) return arg.filter((pair) => !dropped(pair[0]));
        return arg.filter((_, i) => !dropped(arg[i - (i % 2)]));
      }
      if (arg && typeof arg === "object")
        return Object.fromEntries(Object.entries(arg).filter(([name]) => !dropped(name)));
      return arg;
    });
    for (const name of CDN_CACHE_HEADERS) this.removeHeader(name);
    this.setHeader("Cache-Control", NO_STORE);
    return (writeHead as (...a: unknown[]) => Response).apply(this, kept);
  } as Response["writeHead"];
}

/**
 * Express 4 and 5 middleware.
 *
 *   app.get("/api/search", aifpGate({ merchantId, resource: "/api/search", tier: "complex", store }), handler)
 *
 * A gate DECISION never reaches `next(err)`. If a 402 travelled through the
 * partner's error middleware it would come out as whatever that middleware
 * turns unknown errors into — usually a 500 — and an agent cannot pay a 500.
 * Only an unexpected throw (a bug in this package) goes through
 * `onStoreError`, and the default there is still a response, not a rethrow.
 *
 * Both Express majors work because the handler awaits internally and never
 * returns a rejected promise; Express 4 has no promise handling at all, so
 * that is a requirement, not a style choice.
 */
export function aifpGate(options: GateOptions): RequestHandler {
  // Resolved here rather than inside createGate so the refund path can reach
  // the same instance the meter used.
  const store = options.store ?? new MemoryStore({ warnIfDefaulted: true });
  const keyPrefix = options.keyPrefix ?? "aifp:";
  const gate = createGateOn({ ...options, store }, "express");
  const link = discoveryLinkHeader(options.discoveryLink);

  const readsIp = chargeOf(options.shouldCharge) === "unproven" || readsClientIp(options.shouldCharge);
  let proxyChecked = false;
  let proxyUnsetWarned = false;

  return function aifpGateHandler(req: Request, res: Response, next: NextFunction): void {
    // Once per mount, on the first request: the app setting is not known before.
    if (readsIp && !proxyChecked) {
      proxyChecked = true;
      if (req.app?.get("trust proxy") === true) console.warn(TRUST_PROXY_WARNING);
    }
    if (
      readsIp &&
      !proxyUnsetWarned &&
      !req.app?.get("trust proxy") &&
      (req.header("x-forwarded-for") || req.header("cf-connecting-ip"))
    ) {
      proxyUnsetWarned = true;
      console.warn(PROXY_UNSET_WARNING);
    }
    // Only an HTML response carries it, so the gate's own JSON 402 / 403 / 503
    // and a JSON API behind the gate never do.
    linkHtmlResponse(res, link);
    void (async () => {
      try {
        // A router mounted at a prefix strips it from req.path, and patterns name the whole path.
        const fullPath = req.baseUrl + req.path;
        const result = await gate({
          path: fullPath,
          header: (name: string) => req.header(name) ?? undefined,
          ip: req.ip,
          method: req.method,
        });

        if (options.reporting && result.reportingResource && !reportingResponses.has(res)) {
          reportingResponses.add(res);
          const reporting = options.reporting;
          let context: ReportingContext = { channel: "unknown", consent: "unknown" };
          try {
            const claimed = reporting.context?.({ path: fullPath, header: (name) => req.header(name) ?? undefined });
            if (claimed && validReportingContext(claimed)) context = { ...claimed };
            const token = req.header("AIFP-Reporting-Token");
            if (!context.reporting_token && token && validReportingContext({ ...context, reporting_token: token })) {
              context.reporting_token = token;
            }
          } catch {
            /* optional observation context never changes access */
          }
          const resource = result.reportingResource;
          const observe = (event: Omit<ReportedEvent, "id" | "at" | "channel" | "consent">) => {
            try {
              reporting.reporter.observe({ ...context, ...event });
            } catch {
              /* isolated telemetry */
            }
          };
          let terminal = false;
          const finish = () => {
            if (terminal) return;
            terminal = true;
            if (!result.ok) {
              if (result.status === 402 && res.statusCode === 402) {
                const reason =
                  result.body.detail === "quota exhausted — prepay the next batch"
                    ? "quota_exhausted"
                    : req.header("AIFP-Receipt")
                      ? "receipt_rejected"
                      : "receipt_missing";
                observe({ name: "access_challenged", resource, reason });
              }
            } else {
              const status = res.statusCode;
              const outcome =
                status >= 200 && status < 300 ? "success" : status >= 300 && status < 400 ? "redirect" : "error";
              observe({
                name: "resource_response_completed",
                resource,
                status,
                outcome,
                ...(outcome === "error" ? { reason: "upstream_error" } : {}),
              });
            }
          };
          res.once("finish", finish);
          const close = () => {
            if (res.writableFinished) {
              finish();
              return;
            }
            if (terminal) return;
            terminal = true;
            if (result.ok)
              observe({
                name: "resource_response_completed",
                resource,
                outcome: "abort",
                reason: "client_abort",
                ...(res.headersSent ? { status: res.statusCode } : {}),
              });
          };
          res.once("close", close);
          if (result.ok) observe({ name: "access_admitted", resource });
          // Disconnect can happen while async verification/metering is running.
          if (res.destroyed) close();
        }

        // Link is appended: a page may carry other Link values, the discovery one among them.
        const { Link: licenseLink, ...headers } = result.headers;
        res.set(headers);
        if (licenseLink) res.append("Link", licenseLink);
        if (!result.ok) {
          res.status(result.status).json(result.body);
          return;
        }

        req.aifp = result.aifp;
        if (result.aifp.mode === "paid") keepPaidUnstored(res);

        if (options.refundOnError) {
          // 5xx only: a 4xx is the caller's mistake and the merchant did the
          // work of deciding that. Fires after the response is already out —
          // which is exactly why this is opt-in (see README).
          res.once("finish", () => {
            if (res.statusCode >= 500) void refundUnits(store, result.aifp, keyPrefix);
          });
        }

        next();
      } catch (e) {
        // Reaching here means a bug in this package, not a payment decision.
        if ((options.onStoreError ?? "closed") === "open") {
          next();
          return;
        }
        res.status(503).json({
          error: "AIFP-503-METER",
          detail: "payment gate unavailable — retry shortly",
        });
      }
    })();
  };
}
