import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managed } from "./lib-process.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.CONFORMANCE_PYTHON ?? resolve(here, "../.local/py313/bin/python");

export const pythonSubject = (id, label, server) => ({
  id,
  label,
  usesRedis: true,
  capabilities: ["events", "restart", "fault:jwks", "fault:store", "fault:record"],
  async start(ctx) {
    const app = managed(python, [join(here, "app/python_app.py")], {
      PORT: String(ctx.port), AIFP_SERVER: server, AIFP_MERCHANT_ID: ctx.merchantId, AIFP_MERCHANT_SECRET: ctx.secret, AIFP_API: ctx.apiHttps,
      AIFP_MARKER: ctx.fixtures.marker, AIFP_PROFILE: JSON.stringify(ctx.profile), REDIS_PORT: String(ctx.redis.port),
      SSL_CERT_FILE: ctx.caFile, PYTHONUNBUFFERED: "1",
    }, { port: ctx.port, cwd: join(here, "app") });
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
});

export default pythonSubject("python-gate-asgi", "aifinpay-gate on ASGI (Starlette middleware under uvicorn)", "asgi");
