// Offline compatibility probe: real backend invoice handler + built SDK validator.
// The resolver is a synthetic fixture; no route activation, RPC or wallet is used.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { validateSettlementInvoice } from '../node/dist/settlement.js';
if (!process.argv[2]) throw new Error('Usage: node scripts/check-settlement-compat.mjs /path/to/aifinpay-web/backend');
process.env.AIFP_ENV = 'test';
process.env.AIFP_ALLOW_INMEMORY = 'true';
process.env.AIFP_TEST_MODE = 'true';
const requireBackend = createRequire(resolve(process.argv[2], 'package.json'));
const { keccak256, toHex } = requireBackend('viem');
const registryPath = requireBackend.resolve('./app/aifp/splitter-routes');
const original = requireBackend(registryPath);
const synthetic = {
  chain: 'polygon', chainId: 137, version: '1.3', splitter: '0x' + '11'.repeat(20),
  runtimeCodeHash: keccak256('0x6000'), treasuryBps: 100, ipCreatorBps: 0,
  stablecoins: { USDC: '0x' + '22'.repeat(20) },
};
// Fixture only: no policy/registry file changes, server, RPC or signing.
requireBackend.cache[registryPath] = { id: registryPath, filename: registryPath,
  loaded: true, exports: { ...original, resolveSettlingRoute: () => synthetic } };
const router = requireBackend('./interfaces/http/routes/settlement');
const handler = router.stack.find(layer => layer.route?.path === '/v1/settlement/invoice').route.stack[0].handle;
const results = [];
for (const asset of ['POL', 'USDC']) {
  let payload, status = 200;
  await handler({ body: { route_class: 'AIFP-1', chain: 'polygon', asset,
    gross_amount: '1000000', merchant_wallet: '0x' + '33'.repeat(20),
    order_id: 'qa-audit-synthetic-' + asset } }, {
      status(value) { status = value; return this; },
      json(value) { payload = value; return this; },
    });
  const signature = payload.transaction?.function || payload.transaction?.settle?.function;
  let validation;
  try { validateSettlementInvoice(payload); validation = { accepted: true }; }
  catch (error) { validation = { accepted: false, name: error.name, code: error.code, message: error.message }; }
  results.push({ asset, httpStatus: status, signature, selector: signature ? keccak256(toHex(signature)).slice(0,10) : null, validation });
}
for (const result of results) {
  assert.equal(result.httpStatus, 200, JSON.stringify(result));
  assert.equal(result.validation.accepted, true, JSON.stringify(result));
}

console.log(JSON.stringify(results,null,2));
