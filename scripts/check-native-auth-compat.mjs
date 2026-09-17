// Actual built SDK -> actual backend gate, entirely in-process. No network,
// persistent identity, payment or credential output. Seat/RPC and metrics only
// are synthetic; challenge issuance, signing and proof verification are real.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Agent } from '../node/dist/index.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-native-auth-compat.mjs /path/to/backend');
process.env.PUBLIC_ORIGIN = 'https://aifinpay.io';
const requireBackend = createRequire(resolve(process.argv[2], 'package.json'));
for (const [path, exports] of [
  ['./infrastructure/solana', { seatExists: async () => true }],
  ['./infrastructure/redis', { mIncr() {}, redisReady: false }],
]) {
  const id = requireBackend.resolve(path);
  requireBackend.cache[id] = { id, filename: id, loaded: true, exports };
}
const { x402Gate } = requireBackend('./ed25519-gate');

async function run(req) {
  let status = 200, payload;
  await x402Gate(req, {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  }, () => { payload = { ok: true }; });
  return { status, payload };
}

let signedRequests = 0, refusedMutations = 0;
const agent = Agent.new({ baseUrl: process.env.PUBLIC_ORIGIN, fetchImpl: async (url, init) => {
  const parsed = new URL(String(url));
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  assert.equal(init.redirect, 'error');
  const req = { headers, method: init.method, originalUrl: parsed.pathname + parsed.search,
    rawBody: Buffer.from(init.body || '') };
  if (headers['x-signature']) {
    signedRequests++;
    for (const mutation of [
      { originalUrl: '/different' }, { method: init.method === 'GET' ? 'POST' : 'GET' },
      { rawBody: Buffer.from('different body') },
    ]) {
      assert.equal((await run({ ...req, ...mutation })).status, 403);
      refusedMutations++;
    }
  }
  const result = await run(req);
  if (headers['x-signature']) {
    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.notEqual((await run(req)).status, 200, 'consumed nonce must never authorize a replay');
  }
  return Response.json(result.payload, { status: result.status });
} });

for (const init of [{}, { method: 'POST', body: '{"action":"read","resource":"qa"}' }]) {
  const response = await agent.pay('https://aifinpay.io/qa/%D1%82%D0%B5%D1%81%D1%82?kind=summary', init);
  assert.equal(response.status, 200);
}
assert.equal(signedRequests, 2);
assert.equal(refusedMutations, 6);
console.log(JSON.stringify({ source: 'actual SDK and backend gate', acceptedRequests: signedRequests,
  refusedMutations, replayRefused: true, network: false, payments: false }, null, 2));
