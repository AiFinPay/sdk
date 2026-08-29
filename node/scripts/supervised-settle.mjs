#!/usr/bin/env node
/**
 * Supervised v1.3 settlement — the deliberate circle-breaker (AIFINP-213).
 *
 * The SDK refuses to settle on a route the registry has not enabled, and the
 * registry enables a route only after a paid mainnet settlement with verified
 * balance deltas. Someone has to make the first payment on purpose. This is
 * that tool, and it is deliberately NOT the SDK path:
 *
 *   - it reads the route from the canonical table by chain AND route, never
 *     by address, and re-verifies the contract's bytecode hash and owner()
 *     against the chain before it will print anything;
 *   - it does not read `settlementEnabled` at all — that flag is the SDK's
 *     gate, and this script exists to produce the evidence that flips it;
 *   - it never holds a key. `calldata` prints the exact transaction for a
 *     wallet to sign (to, value, data) with the selector shown; `verify`
 *     takes the resulting hash and proves what happened from chain state.
 *
 *   node scripts/supervised-settle.mjs calldata polygon merchant-aifp1 \
 *        --merchant 0x… --amount 0.5 --order supervised-001 [--ttl 900]
 *
 *   node scripts/supervised-settle.mjs verify polygon merchant-aifp1 0x<txhash>
 *
 * `verify` fails closed: it re-derives the expected split from the route's
 * bps, reads the payer/merchant/treasury balances at the block before and the
 * block of the transaction, decodes the Payment event, and requires all three
 * to agree. Gas is accounted for on the payer side from the receipt.
 *
 * Build first: `npm run build` — this imports the compiled table so the
 * addresses are exactly what the SDK would use.
 */
import { createPublicClient, http, encodeFunctionData, decodeEventLog, keccak256, toHex, parseEther, formatEther, getAddress } from "viem";
import { SPLITTER_ROUTES, SPLITTER_GOVERNANCE } from "../dist/splitterRoutes.generated.js";
import { V13_ABI, SETTLEMENT_V13_SELECTORS } from "../dist/settlement.js";

const [mode, chain, routeName, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i === -1 ? fallback : rest[i + 1]; };
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!["calldata", "verify"].includes(mode) || !chain || !routeName) {
  die("usage: supervised-settle.mjs <calldata|verify> <chain> <route> …  (see header)");
}
const route = SPLITTER_ROUTES[`${chain}:${routeName}`];
if (!route) die(`no canonical route ${chain}:${routeName} — selection is by chain AND route, never by address`);

const rpc = flag("rpc", route.defaultRpc);
const client = createPublicClient({ chain: route.viemChain, transport: http(rpc) });
const lc = (a) => a.toLowerCase();

// Chain must agree with the registry before anything else happens.
const chainId = await client.getChainId();
if (chainId !== route.chainId) die(`RPC serves chain ${chainId}, registry says ${route.chainId}`);
const code = await client.getBytecode({ address: route.splitter });
if (!code || code === "0x") die(`no code at ${route.splitter}`);
if (lc(keccak256(code)) !== lc(route.runtimeCodeHash)) die("runtime code hash does not match the registry");
const owner = await client.readContract({ address: route.splitter, abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "owner" });
if (lc(owner) !== lc(route.owner) || lc(owner) !== lc(SPLITTER_GOVERNANCE.safe)) die(`owner() is ${owner}, expected the governance Safe ${SPLITTER_GOVERNANCE.safe}`);
const [treasuryBps, ipCreatorBps, treasury] = await Promise.all([
  client.readContract({ address: route.splitter, abi: [{ type: "function", name: "treasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "treasuryBps" }),
  client.readContract({ address: route.splitter, abi: [{ type: "function", name: "ipCreatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "ipCreatorBps" }),
  client.readContract({ address: route.splitter, abi: [{ type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "treasury" }),
]);
if (Number(treasuryBps) !== route.treasuryBps || Number(ipCreatorBps) !== route.ipCreatorBps) die("on-chain bps do not match the registry");
if (lc(treasury) !== lc(route.treasury)) die(`treasury() is ${treasury}, registry says ${route.treasury}`);
console.log(`✓ ${chain}:${routeName} ${route.splitter} — chain ${chainId}, hash, owner (${owner.slice(0, 10)}…), ${route.treasuryBps}/${route.ipCreatorBps} bps, treasury ${treasury.slice(0, 10)}… all match the registry`);

const split = (gross) => {
  const t = (gross * BigInt(route.treasuryBps)) / 10_000n;
  const c = (gross * BigInt(route.ipCreatorBps)) / 10_000n;
  return { merchant: gross - t - c, treasury: t, creator: c };
};

if (mode === "calldata") {
  const merchant = getAddress(flag("merchant") ?? die("--merchant required"));
  const amount = flag("amount") ?? die("--amount required (native units, e.g. 0.5)");
  const orderId = flag("order") ?? die("--order required");
  const ttl = Number(flag("ttl", "900"));
  const gross = parseEther(amount);
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + ttl);
  const paymentId = keccak256(toHex(orderId));
  const s = split(gross);
  if (s.treasury === 0n && route.treasuryBps > 0) die("amount too small — treasury leg rounds to zero and the contract reverts");
  const data = encodeFunctionData({ abi: V13_ABI, functionName: "payNative", args: [{ paymentId, merchant, grossAmount: gross, ipCreator: "0x0000000000000000000000000000000000000000", validUntil, orderId }] });
  if (data.slice(0, 10) !== SETTLEMENT_V13_SELECTORS.payNative) die("encoded selector is not the deployed payNative selector");
  console.log(`\nSign this from the payer wallet on ${route.viemChain.name} (chain ${route.chainId}):`);
  console.log(`  to     ${route.splitter}`);
  console.log(`  value  ${gross} wei  (${amount} ${route.viemChain.nativeCurrency.symbol})`);
  console.log(`  data   ${data}`);
  console.log(`\nselector ${data.slice(0, 10)} = payNative((bytes32,address,uint256,address,uint256,string))`);
  console.log(`paymentId ${paymentId}  (keccak256("${orderId}"))`);
  console.log(`validUntil ${validUntil} (${new Date(Number(validUntil) * 1000).toISOString()})`);
  console.log(`expected split: merchant ${formatEther(s.merchant)}, treasury ${formatEther(s.treasury)}, creator ${formatEther(s.creator)}`);
  console.log(`\nthen: node scripts/supervised-settle.mjs verify ${chain} ${routeName} <txhash>`);
  process.exit(0);
}

// verify
const txHash = rest[0];
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? "")) die("verify needs a 0x transaction hash");
const receipt = await client.getTransactionReceipt({ hash: txHash });
if (receipt.status !== "success") die(`transaction ${txHash} reverted`);
if (lc(receipt.to) !== lc(route.splitter)) die(`transaction went to ${receipt.to}, not the registry splitter ${route.splitter}`);
const tx = await client.getTransaction({ hash: txHash });
if (tx.input.slice(0, 10) !== SETTLEMENT_V13_SELECTORS.payNative) die(`calldata selector ${tx.input.slice(0, 10)} is not payNative (${SETTLEMENT_V13_SELECTORS.payNative})`);

const paymentLog = receipt.logs.map((l) => { try { return decodeEventLog({ abi: V13_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "Payment");
if (!paymentLog) die("no Payment event in the receipt");
const ev = paymentLog.args;
const gross = ev.totalAmount;
const expected = split(gross);
const problems = [];
if (ev.merchantAmount !== expected.merchant) problems.push(`event merchantAmount ${ev.merchantAmount} ≠ expected ${expected.merchant}`);
if (ev.treasuryAmount !== expected.treasury) problems.push(`event treasuryAmount ${ev.treasuryAmount} ≠ expected ${expected.treasury}`);
if (ev.ipCreatorAmount !== expected.creator) problems.push(`event ipCreatorAmount ${ev.ipCreatorAmount} ≠ expected ${expected.creator}`);
if (tx.value !== gross) problems.push(`tx value ${tx.value} ≠ event totalAmount ${gross}`);
if (lc(ev.payer) !== lc(tx.from)) problems.push(`event payer ${ev.payer} ≠ tx.from ${tx.from}`);

const before = receipt.blockNumber - 1n, at = receipt.blockNumber;
const bal = async (a, b) => client.getBalance({ address: a, blockNumber: b });
const [payer0, payer1, merch0, merch1, treas0, treas1, splitter0, splitter1] = await Promise.all([
  bal(tx.from, before), bal(tx.from, at), bal(ev.merchant, before), bal(ev.merchant, at),
  bal(treasury, before), bal(treasury, at), bal(route.splitter, before), bal(route.splitter, at),
]);
const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
const payerDelta = payer0 - payer1;
// Same-block noise (other txs touching these accounts) would show here as a
// mismatch; that is a reason to look, not a reason to explain it away.
if (payerDelta !== gross + gasPaid) problems.push(`payer balance fell by ${payerDelta}, expected gross ${gross} + gas ${gasPaid} = ${gross + gasPaid}`);
if (merch1 - merch0 !== expected.merchant) problems.push(`merchant balance rose by ${merch1 - merch0}, expected ${expected.merchant}`);
if (treas1 - treas0 !== expected.treasury) problems.push(`treasury balance rose by ${treas1 - treas0}, expected ${expected.treasury}`);
if (splitter1 !== splitter0) problems.push(`splitter balance changed by ${splitter1 - splitter0}; it must retain nothing`);

console.log(`\nPayment ${ev.paymentId} in block ${at}, tx ${txHash}`);
console.log(`  payer     ${ev.payer}  −${formatEther(gross)} −gas ${formatEther(gasPaid)}`);
console.log(`  merchant  ${ev.merchant}  +${formatEther(ev.merchantAmount)}`);
console.log(`  treasury  ${treasury}  +${formatEther(ev.treasuryAmount)}`);
console.log(`  creator   ${formatEther(ev.ipCreatorAmount)}  (route carries ${route.ipCreatorBps} bps)`);
console.log(`  orderId   "${ev.orderId}"  validUntil ${ev.validUntil}`);
if (problems.length) { console.error("\n✗ NOT VERIFIED:"); for (const p of problems) console.error(`  ${p}`); process.exit(1); }
console.log(`\n✓ VERIFIED — balance deltas match the ${route.treasuryBps}/${route.ipCreatorBps} bps profile exactly; the splitter retained nothing.`);
console.log(`This is the evidence for setting ${chain}:${routeName} settlementEnabled: true in registry/registry.json (evm-contract), then npm run registry:sync.`);
