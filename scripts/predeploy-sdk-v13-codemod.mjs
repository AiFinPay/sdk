import fs from 'node:fs';

function patchFile(path, patches) {
  let src = fs.readFileSync(path, 'utf8');
  for (const { from, to, label } of patches) {
    const count = src.split(from).length - 1;
    if (count === 0 && src.includes(to)) continue;
    if (count !== 1) throw new Error(`${path} ${label}: expected one source match, found ${count}`);
    src = src.replace(from, to);
  }
  fs.writeFileSync(path, src);
  console.log(`patched ${path}`);
}

patchFile('node/src/unifiedAgent.ts', [
  {
    label: 'spend-ledger import',
    from: 'import { Agent, type AgentOptions } from "./agent.js";\n',
    to: 'import { Agent, type AgentOptions } from "./agent.js";\nimport { type SpendLedger, MemorySpendLedger, FileSpendLedger } from "./spendLedger.js";\n',
  },
  {
    label: 'spend-ledger option',
    from: '  polygonRpc?:   string;     // default: https://polygon.drpc.org\n  solanaRpc?:    string;     // default: env AIFINPAY_SOLANA_RPC or mainnet-beta\n',
    to: '  polygonRpc?:   string;     // default: https://polygon.drpc.org\n  /** Durable daily-spend ledger. Defaults to a file when daily_usd is configured. */\n  spendLedger?:  SpendLedger;\n  solanaRpc?:    string;     // default: env AIFINPAY_SOLANA_RPC or mainnet-beta\n',
  },
  {
    label: 'bridge absolute expiry',
    from: '    function_signature?:   string;\n    ttl_seconds?:          number;\n',
    to: '    function_signature?:   string;\n    /** Absolute Unix seconds bound into the v1.3 contract call. */\n    valid_until?:          string;\n    ttl_seconds?:          number;\n',
  },
  {
    label: 'v1.3 ABI',
    from: `// v1.3 fee-on-top entrypoint. v1.1/v1.2 remain recognized only so
// the validator can reject them explicitly; they may not reach signing.
export const SPLITTER_PAY_NATIVE_ABI = [
  {
    type: "function",
    name: "payNative",
    stateMutability: "payable",
    inputs: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "merchant" },
      { type: "uint256", name: "merchantAmount" },
      { type: "address", name: "ipCreator" },
      { type: "string",  name: "memo" },
    ],
    outputs: [],
  },
] as const;`,
    to: `// v1.3 gross-inclusive entrypoint. v1.1/v1.2 are legacy and may not
// reach signing for current AIFP-1/AIFP-2 routes.
export const SPLITTER_PAY_NATIVE_ABI = [
  {
    type: "function",
    name: "payNative",
    stateMutability: "payable",
    inputs: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "merchant" },
      { type: "uint256", name: "grossAmount" },
      { type: "address", name: "ipCreator" },
      { type: "uint256", name: "validUntil" },
      { type: "string",  name: "orderId" },
    ],
    outputs: [],
  },
] as const;`,
  },
  {
    label: 'ledger fields',
    from: '  private  budgetCaps:     BudgetCaps;\n  private  spend24h        = new SpendTracker();\n  private  telemetry:      boolean;\n',
    to: '  private  budgetCaps:     BudgetCaps;\n  private  spend24h        = new SpendTracker(); // reporting; enforcement uses SpendLedger\n  private  _ledger?:       SpendLedger;\n  private  ledgerOverride?: SpendLedger;\n  private  telemetry:      boolean;\n',
  },
  {
    label: 'ledger constructor wiring',
    from: '    this.budgetCaps  = opts.budgetCaps ?? {};\n    this.telemetry   = opts.telemetry !== false;\n',
    to: '    this.budgetCaps  = opts.budgetCaps ?? {};\n    if (opts.spendLedger) this.ledgerOverride = opts.spendLedger;\n    this.telemetry   = opts.telemetry !== false;\n',
  },
  {
    label: 'budget enforcement',
    from: `  /**
   * Internal pre-call check. Returns \`false\` only when on_limit_exceeded
   * is "skip" and a cap is hit — \`call()\` should then resolve to null
   * without submitting an on-chain tx. Throws BudgetCapExceededError
   * in the default "throw" mode.
   */
  private checkBudget(costUsd: number): boolean {
    const mode = this.budgetCaps.on_limit_exceeded ?? "throw";

    if (this.budgetCaps.per_call_usd !== undefined && costUsd > this.budgetCaps.per_call_usd) {
      const err = new BudgetCapExceededError(
        "per_call",
        \`cost $\${costUsd} exceeds per-call cap $\${this.budgetCaps.per_call_usd}\`,
      );
      if (mode === "skip") return false;
      throw err;
    }
    const after = this.spend24h.total24h() + costUsd;
    if (this.budgetCaps.daily_usd !== undefined && after > this.budgetCaps.daily_usd) {
      const err = new BudgetCapExceededError(
        "daily",
        \`daily spend \${after.toFixed(4)} would exceed cap $\${this.budgetCaps.daily_usd}\`,
      );
      if (mode === "skip") return false;
      throw err;
    }
    return true;
  }
`,
    to: `  private get ledger(): SpendLedger {
    if (this.ledgerOverride) return this.ledgerOverride;
    if (!this._ledger) {
      this._ledger = this.budgetCaps.daily_usd !== undefined
        ? FileSpendLedger.forAgent(this.evmAddress)
        : new MemorySpendLedger();
    }
    return this._ledger;
  }

  private checkPerCall(costUsd: number): boolean {
    const cap = this.budgetCaps.per_call_usd;
    if (cap === undefined || costUsd <= cap) return true;
    const err = new BudgetCapExceededError("per_call", \`cost $\${costUsd} exceeds per-call cap $\${cap}\`);
    if ((this.budgetCaps.on_limit_exceeded ?? "throw") === "skip") return false;
    throw err;
  }

  private async reserveDaily(costUsd: number): Promise<string | null | "skip"> {
    const cap = this.budgetCaps.daily_usd;
    if (cap === undefined) return null;
    const id = await this.ledger.reserve(costUsd, cap, 24 * 3600 * 1000);
    if (id) return id;
    const err = new BudgetCapExceededError("daily", \`this call would take daily spend past the $\${cap} cap\`);
    if ((this.budgetCaps.on_limit_exceeded ?? "throw") === "skip") return "skip";
    throw err;
  }
`,
  },
  {
    label: 'remove eager non-atomic budget check',
    from: '    const withinBudget = this.checkBudget(cost);\n    if (!withinBudget) return null;\n\n',
    to: '',
  },
  {
    label: 'solana durable reserve',
    from: '      const solTxSig = await this.submitSolanaB2BPay(ps, validatedSolana);\n',
    to: `      if (!this.checkPerCall(cost)) return null;
      const reservation = await this.reserveDaily(cost);
      if (reservation === "skip") return null;
      let solTxSig: string;
      try {
        solTxSig = await this.submitSolanaB2BPay(ps, validatedSolana);
      } catch (e) {
        if (typeof reservation === "string") await this.ledger.release(reservation);
        throw e;
      }
      if (typeof reservation === "string") await this.ledger.commit(reservation, cost);
`,
  },
  {
    label: 'EVM calldata and ledger',
    from: `    // 2. Only a canonical v1.3 fee-on-top quote can reach signing.
    // v1.1/v1.2 and dynamic server-selected ABIs are intentionally unavailable.
    await this.assertCanAffordNative(publicClient, deployment, validatedPayment.totalWei);
    const txHash = await walletClient.writeContract({
      address:      validatedPayment.splitter,
      abi:          SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [
        paymentIdFor(validatedPayment.orderId),
        validatedPayment.merchant,
        validatedPayment.merchantAmountWei,
        validatedPayment.ipCreator,
        validatedPayment.orderId,
      ],
      value: validatedPayment.totalWei,
      chain: deployment.chain,
      account: this.evmAccount,
    });

    // 3. Wait for receipt (inclusion is enough on these fast-block chains).
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new AiFinPayError(\`\${deployment.chain.name} tx reverted: \${txHash}\`);
    }
`,
    to: `    // 2. Only a canonical v1.3 gross-inclusive quote can reach signing.
    // v1.1/v1.2 and dynamic server-selected ABIs are intentionally unavailable.
    if (!this.checkPerCall(cost)) return null;
    const reservation = await this.reserveDaily(cost);
    if (reservation === "skip") return null;
    await this.assertCanAffordNative(publicClient, deployment, validatedPayment.totalWei);
    let txHash: \`0x\${string}\`;
    try {
      txHash = await walletClient.writeContract({
        address:      validatedPayment.splitter,
        abi:          SPLITTER_PAY_NATIVE_ABI,
        functionName: "payNative",
        args: [
          paymentIdFor(validatedPayment.orderId),
          validatedPayment.merchant,
          validatedPayment.grossAmountWei,
          validatedPayment.ipCreator,
          validatedPayment.validUntil,
          validatedPayment.orderId,
        ],
        value: validatedPayment.totalWei,
        chain: deployment.chain,
        account: this.evmAccount,
      });
      // Once broadcast, keep the reservation charged unless we can prove a revert.
      if (typeof reservation === "string") await this.ledger.commit(reservation, cost);
    } catch (e) {
      if (typeof reservation === "string") await this.ledger.release(reservation);
      throw e;
    }

    // 3. Wait for receipt (inclusion is enough on these fast-block chains).
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      if (typeof reservation === "string") await this.ledger.release(reservation);
      throw new AiFinPayError(\`\${deployment.chain.name} tx reverted: \${txHash}\`);
    }
`,
  },
  {
    label: 'settle helper comment',
    from: '   * Settle a native-token splitter payment, v1.3 fee-on-top only.\n',
    to: '   * Settle a native-token splitter payment, v1.3 gross-inclusive only.\n',
  },
  {
    label: 'settle helper calldata',
    from: `      args: [
        paymentIdFor(validated.orderId),
        validated.merchant,
        validated.merchantAmountWei,
        validated.ipCreator,
        validated.orderId,
      ],`,
    to: `      args: [
        paymentIdFor(validated.orderId),
        validated.merchant,
        validated.grossAmountWei,
        validated.ipCreator,
        validated.validUntil,
        validated.orderId,
      ],`,
  },
  {
    label: 'fetchPaid expiry in quote',
    from: `          ip_creator_amount_wei: p.ipCreatorAmountWei?.toString(),
        },
      }),`,
    to: `          ip_creator_amount_wei: p.ipCreatorAmountWei?.toString(),
          valid_until:           p.validUntil.toString(),
        },
      }),`,
  },
  {
    label: 'fetchPaid durable budget hooks',
    from: `      // The remediation branch replaced the file-backed reservation ledger
      // with in-memory caps, so there is no reservation to resolve: checkBudget
      // covers both per-call and daily, and onPaid records the spend once the
      // money has actually moved.
      checkPerCall: (usd) => this.checkBudget(usd),
      reserveDaily: (usd) => Promise.resolve(this.checkBudget(usd) ? null : "skip"),
      commit:  () => Promise.resolve(),
      release: () => Promise.resolve(),
      onPaid: ({ merchantId, amountUsd, txRef }) => {
        this.spend24h.add(amountUsd);`,
    to: `      checkPerCall: (usd) => this.checkPerCall(usd),
      reserveDaily: (usd) => this.reserveDaily(usd),
      commit: async (id, usd) => { await this.ledger.commit(id, usd); },
      release: async (id) => { await this.ledger.release(id); },
      onPaid: ({ merchantId, amountUsd, txRef }) => {
        this.spend24h.add(amountUsd);`,
  },
]);

patchFile('node/src/aifp1.ts', [
  {
    label: 'native quote semantics',
    from: `  /** Present only when the backend had a live POL rate at quote time. */
  native_settlement?: {
    asset:        string;       // "POL"
    decimals:     number;
    rate_usd:     string;
    total_wei:    string;
    merchant_wei: string;
    treasury_wei: string;
    creator_wei:  string;
  };`,
    to: `  /** Native Polygon v1.3 gross settlement, when enabled by backend readiness. */
  native_settlement?: {
    asset:        string;       // "POL"
    decimals:     number;
    rate_usd:     string;
    total_wei:    string;       // gross payer amount
    merchant_wei: string;
    treasury_wei: string;
    creator_wei:  string;
    valid_until?: string;       // Unix seconds; must equal quote expires_at
  };`,
  },
  {
    label: 'AIFP1 settlement gross fields',
    from: `  settlement: {
    batch_units: string;
    total_units: string;
    fee_on_top:  { provider: string; treasury: string; creator: string };
  };`,
    to: `  settlement: {
    batch_units: string;
    total_units: string;
    gross_units?: string;
    payer_total_units?: string;
    merchant_units?: string;
    protocol_fee_units?: string;
    creator_units?: string;
    fee_on_top?: false | { provider: string; treasury: string; creator: string };
  };`,
  },
  {
    label: 'settle dependency validUntil',
    from: `    orderId:             string;
    merchantAmountWei?:  bigint;`,
    to: `    orderId:             string;
    validUntil:          bigint;
    merchantAmountWei?:  bigint;`,
  },
  {
    label: 'settle dependency comment',
    from: `   * The component amounts are passed through as the gateway quoted them, not
   * recomputed here: the v1.3 splitter is fee-on-top and the settling side
   * checks each component against its own registry. Sending only the total
   * would leave nothing to check that against.`,
    to: `   * The component amounts are passed through as quote evidence. The v1.3
   * splitter receives one gross payer amount and splits fees from gross. The
   * settling side validates all supplied components against its own registry.`,
  },
  {
    label: 'quote expiry prepayment validation',
    from: `    if (quote.merchant_id !== challenge.merchant_id) {
      throw new Aifp1QuoteError(
        \`quote \${quote.quote_id} is for merchant \${quote.merchant_id} but \${site} refused as \${challenge.merchant_id} — refusing to pay\`,
      );
    }

    // 3. Budget.`,
    to: `    if (quote.merchant_id !== challenge.merchant_id) {
      throw new Aifp1QuoteError(
        \`quote \${quote.quote_id} is for merchant \${quote.merchant_id} but \${site} refused as \${challenge.merchant_id} — refusing to pay\`,
      );
    }
    const quoteExpiryMs = Date.parse(quote.expires_at);
    if (!Number.isFinite(quoteExpiryMs) || quoteExpiryMs <= Date.now()) {
      throw new Aifp1QuoteError(\`quote \${quote.quote_id} is expired or has invalid expires_at\`);
    }

    // 3. Budget.`,
  },
  {
    label: 'settle validUntil call',
    from: `        orderId:        quote.quote_id,
        // Forwarded verbatim so the settling side can check the split against`,
    to: `        orderId:        quote.quote_id,
        validUntil:     BigInt(Math.floor(quoteExpiryMs / 1000)),
        // Forwarded verbatim so the settling side can check the split against`,
  },
]);
