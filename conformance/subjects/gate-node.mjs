import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managed } from "./lib-process.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const gateDir = process.env.GATE_DIR ? resolve(process.env.GATE_DIR) : resolve(here, "../../gate");

export default {
  id: "gate-node",
  label: "@aifinpay/gate on Express",
  usesRedis: true,
  capabilities: ["events", "restart", "fault:jwks", "fault:store", "fault:record", "llms_txt_absent"],
  version: () => JSON.parse(readFileSync(join(gateDir, "package.json"), "utf8")).version,
  async start(ctx) {
    const app = managed(process.execPath, [join(here, "app/express-app.mjs")], {
      PORT: String(ctx.port), GATE_DIR: gateDir, AIFP_MERCHANT_ID: ctx.merchantId, AIFP_MERCHANT_SECRET: ctx.secret,
      AIFP_API: ctx.apiHttps, AIFP_JWKS_URI: `${ctx.apiHttps}/.well-known/jwks.json`, AIFP_MARKER: ctx.fixtures.marker,
      AIFP_PROFILE: JSON.stringify(ctx.profile), REDIS_PORT: String(ctx.redis.port), NODE_EXTRA_CA_CERTS: ctx.caFile,
    }, { port: ctx.port });
    await app.up();
    const baseUrl = `http://127.0.0.1:${ctx.port}`;
    return {
      baseUrl,
      apiBase: ctx.apiHttps,
      flushEvents: () => fetch(`${baseUrl}/__conformance/flush`).catch(() => {}),
      restart: () => app.restart(),
      breakStore: () => ctx.redis.stop(),
      healStore: () => ctx.redis.start(),
      stop: () => app.down(),
    };
  },
};
