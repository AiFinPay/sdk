import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createGate, refundUnits, type GateOptions } from "./core.js";
import { MemoryStore } from "./stores/memory.js";
import type { AifpContext } from "./types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aifp?: AifpContext;
    }
  }
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
  const gate = createGate({ ...options, store });

  return function aifpGateHandler(req: Request, res: Response, next: NextFunction): void {
    void (async () => {
      try {
        const result = await gate({
          path: req.path,
          header: (name: string) => req.header(name) ?? undefined,
        });

        res.set(result.headers);
        if (!result.ok) {
          res.status(result.status).json(result.body);
          return;
        }

        req.aifp = result.aifp;

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
