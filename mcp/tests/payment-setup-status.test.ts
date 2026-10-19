// payment_setup_status: the checklist between "connected" and "first payment".
//
// A fresh agent on 2026-10-19 never paid because nothing told it, in order,
// what was missing: it saw no payment tool, a wallet that changed address on
// every start, and a 402 with a price but no idea what to fund. Each test here
// is one of those states and the single next_step the tool must give for it.

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { paymentSetupStatus, runPaymentSetupStatus, PAYMENT_ENV } from "../src/tools/payment-setup-status.js";
import { PaymentStateStore } from "../src/payment-state.js";
import type { ToolContext } from "../src/server.js";

const address = "0x" + "12".repeat(20);
const origin = "https://dev.ratersapp.com";
const limits = {
  maxAmountUsd: 0.15,
  dailyAmountUsd: 1,
  maxGasPol: "0.3",
  gatewayOrigins: [origin],
  gatewayPathMode: "direct" as const,
};

/** An RPC that answers eth_getBalance with `wei`, and a Coinbase price of $0.20/POL. */
function network(wei: bigint) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.method === "eth_getBalance")
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + wei.toString(16) });
    if (body?.method === "eth_call") return new Response("no feed", { status: 500 });
    if (input.includes("coinbase")) return Response.json({ data: { base: "POL", currency: "USD", amount: "0.20" } });
    return new Response("unexpected", { status: 500 });
  });
}

function ctx(
  config: ToolContext["config"],
  walletSource: string | undefined,
  fetchImpl: ReturnType<typeof network> = network(0n)
): ToolContext {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-status-"));
  return {
    config: { walletHome: home, ...config },
    walletSource,
    paymentState: walletSource && walletSource !== "ephemeral" ? new PaymentStateStore(address, home) : undefined,
    log: vi.fn(),
    agent: { evmAddress: address, inner: { fetchImpl } },
  } as unknown as ToolContext;
}

describe("payment_setup_status", () => {
  it("with nothing configured: points at init, names the ephemeral address as not to be funded, touches no network", async () => {
    const f = network(0n);
    const c = ctx({}, "ephemeral", f);
    const status = await paymentSetupStatus(c, { readBalance: true });
    expect(status.ready).toBe(false);
    expect(status.wallet).toEqual({ persistent: false, source: "ephemeral", evm_address: address });
    expect(status.payments_enabled).toBe(false);
    expect(status.limits.max_usd).toEqual({ env: "AIFINPAY_MAX_USD", set: false });
    expect(status.limits.gas_cap).toEqual({ env: "AIFINPAY_MAX_GAS_POL", set: false });
    expect(status.balance).toBe("unknown");
    expect(status.next_step).toContain("npx @aifinpay/mcp init");
    expect(status.next_step).toContain(`do not fund ${address}`);
    expect(f).not.toHaveBeenCalled();
  });

  // The agent runs init in its own shell, which does not have the server's
  // AIFINPAY_HOME: a bare command wrote ~/.aifinpay/agent.json and the server
  // never saw it.
  it("with AIFINPAY_HOME set: the init command carries it, shell-quoted", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "aifp-mcp-status-")), "it's here");
    const status = await paymentSetupStatus(ctx({ walletHome: home }, "ephemeral"), { readBalance: true });
    expect(status.next_step).toContain(`Run \`AIFINPAY_HOME='${home.replace("'", "'\\''")}' npx @aifinpay/mcp init\``);
  });

  it("without AIFINPAY_HOME: the init command is the bare one", async () => {
    const status = await paymentSetupStatus(ctx({ walletHome: undefined }, "ephemeral"), { readBalance: true });
    expect(status.next_step).toContain("Run `npx @aifinpay/mcp init`");
    expect(status.next_step).not.toContain("AIFINPAY_HOME");
  });

  it("with an encrypted keystore it cannot open: never touch it, init a new, empty AIFINPAY_HOME", async () => {
    const c = ctx({}, "ephemeral");
    const keystore = join(c.config.walletHome!, "agent.json");
    writeFileSync(keystore, JSON.stringify({ enc: "scrypt-aes-256-gcm", salt: "", iv: "", tag: "", ct: "" }));
    const status = await paymentSetupStatus(c, { readBalance: true });
    expect(status.ready).toBe(false);
    expect(status.next_step).toContain(`${keystore} is an encrypted wallet that cannot be opened here`);
    expect(status.next_step).toMatch(/Do not delete, move or overwrite it/);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(status.next_step).toContain(
      `\`AIFINPAY_HOME='${join(homedir(), ".aifinpay", `agent-${today}`)}' npx @aifinpay/mcp init\``
    );
    expect(status.next_step).toContain("it includes AIFINPAY_HOME");
    // With the passphrase configured the server could open it; the advice is init's.
    const open = await paymentSetupStatus(
      { ...c, config: { ...c.config, walletPassphrase: "set" } },
      {
        readBalance: true,
      }
    );
    expect(open.next_step).not.toContain("cannot be opened");
  });

  it("with a persistent wallet and payments off: gives the owner the exact env block, keeping their origin", async () => {
    const status = await paymentSetupStatus(ctx({ gatewayOrigins: [origin] }, "legacy-keystore"), {
      readBalance: true,
    });
    expect(status.ready).toBe(false);
    expect(status.wallet.persistent).toBe(true);
    expect(status.limits.origins).toEqual({ env: "AIFINPAY_GATEWAY_ORIGINS", set: true, value: [origin] });
    expect(status.config_error).toMatch(/AIFINPAY_MAX_USD/);
    expect(status.next_step).toContain('"AIFINPAY_PAYMENTS_ENABLED":"1"');
    expect(status.next_step).toContain(`"AIFINPAY_GATEWAY_ORIGINS":"${origin}"`);
    expect(status.next_step).toContain('"AIFINPAY_MAX_GAS_POL":"0.3"');
    expect(status.next_step).toContain("reconnect");
    // Every example key the owner needs is in the block; nothing is invented.
    for (const key of Object.keys(PAYMENT_ENV)) expect(status.next_step).toContain(`"${key}"`);
  });

  it("with payments enabled but a limit refused: repeats the server's own refusal", async () => {
    const status = await paymentSetupStatus(
      ctx({ paymentsEnabled: true, ...limits, maxGasPol: "lots" }, "legacy-keystore"),
      { readBalance: true }
    );
    expect(status.ready).toBe(false);
    expect(status.config_error).toMatch(/AIFINPAY_MAX_GAS_POL/);
    expect(status.next_step).toMatch(/^Owner setting refused: AIFINPAY_MAX_GAS_POL/);
  });

  it("with everything set and an empty wallet: says what to fund, where, and about how much", async () => {
    const status = await paymentSetupStatus(ctx({ paymentsEnabled: true, ...limits }, "legacy-keystore"), {
      readBalance: true,
    });
    expect(status.ready).toBe(false);
    expect(status.balance).toEqual({
      amount: "0.0000",
      asset: "POL",
      chain: "polygon",
      rpc: "https://polygon.drpc.org",
    });
    // $0.10 at $0.20/POL is 0.5 POL, plus the 0.3 POL gas cap.
    expect(status.next_step).toBe(
      `Fund ${address} on Polygon with about 0.80 POL (the smallest batch is $0.10 ≈ 0.5000 POL plus up to 0.3 POL gas; it holds 0.0000), then call payment_setup_status again.`
    );
  });

  it("with a funded wallet: ready, and the next step is payable_fetch within the limits", async () => {
    const status = await paymentSetupStatus(
      ctx({ paymentsEnabled: true, ...limits }, "legacy-keystore", network(10n ** 18n)),
      { readBalance: true }
    );
    expect(status.ready).toBe(true);
    expect(status.balance).toMatchObject({ amount: "1.0000", asset: "POL" });
    expect(status.next_step).toContain("payable_fetch");
    expect(status.next_step).toContain(origin);
    expect(status.next_step).toContain("$0.15 per call");
  });

  it("reads the balance over the owner's RPC when set, and reports an unreadable RPC without failing", async () => {
    const f = vi.fn(async () => new Response("down", { status: 503 }));
    const status = await paymentSetupStatus(
      ctx({ paymentsEnabled: true, ...limits, rpcUrl: "https://rpc.owner.example" }, "legacy-keystore", f as never),
      { readBalance: true }
    );
    expect(f.mock.calls[0][0]).toBe("https://rpc.owner.example");
    expect(status.ready).toBe(true);
    expect(status.balance).toBe("unknown");
    expect(status.balance_error).toContain("https://rpc.owner.example");
    expect(status.next_step).toContain("must hold the batch price plus up to the gas cap");
  });

  it("does not read a balance when asked not to (payable_fetch's refusal path)", async () => {
    const f = network(0n);
    const status = await paymentSetupStatus(ctx({ paymentsEnabled: true, ...limits }, "legacy-keystore", f), {
      readBalance: false,
    });
    expect(f).not.toHaveBeenCalled();
    expect(status.balance).toBe("unknown");
  });

  it("the tool result is the status, with structuredContent, and never a secret", async () => {
    const result = await runPaymentSetupStatus(ctx({}, "ephemeral"), {});
    expect(result.structuredContent).toMatchObject({ ready: false, wallet: { persistent: false } });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.content[0].text).not.toMatch(/secret|seed/i);
  });
});
