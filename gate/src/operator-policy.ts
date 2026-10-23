// ──────────────────────────────────────────────────────────────────────────
// Per-operator access policy — allow / charge / block, decided by the merchant.
//
// The rules live in the merchant's access policy on the control plane and
// travel on the public merchant view (`GET /v1/merchants/:id` →
// `operator_rules`, `operator_default`), which the ResourceRegistry reads next
// to the resource list. This file is the gate's half: the same precedence as
// backend/app/aifp/policy.js decideOperator, applied to what classifyAgent
// says about a request. No I/O, no dependencies — it is part of
// @aifinpay/gate/edge too.
//
// What a rule can and cannot say:
//   allow  — serve free, unmetered (the same answer as a shouldCharge exemption).
//   charge — the gate's own decision: shouldCharge, then the receipt path.
//            This is also the default, so a merchant who never saved a rule
//            has a gate that behaves exactly as it did before rules existed.
//   block  — 403, AIFP-403.
// A `verified_only` rule applies only once the request's AIFP receipt has
// verified; a caller whose identity is a claim (a User-Agent, an AIFP-Agent-Id
// header, a receipt that did not verify) falls through to the next rule.
// Readers (`ua_class: human`) are never matched: who pays on a page with
// human readers is the merchant's shouldCharge predicate, not a rule here.
// ──────────────────────────────────────────────────────────────────────────
import { GATE_OPERATORS, UA_CLASSES, type AgentIdentity } from "./agents.js";
import type { OperatorAction, OperatorPolicy, OperatorRule } from "./types.js";

export const OPERATOR_ACTIONS = ["allow", "charge", "block"] as const;
/** What an operator with no rule gets, and what an unconfigured policy says. */
export const OPERATOR_DEFAULT: OperatorAction = "charge";

export interface OperatorDecision {
  action: OperatorAction;
  /** Which rule decided: the caller's operator, its class, the default, or
   *  none (a reader, or no policy at all). */
  matched: "operator" | "ua_class" | "default" | "none";
  rule: OperatorRule | null;
  /** The one-line account stamped on the event — `operator policy: block
   *  (operator=openai)` — in enforce and shadow alike, so a shadow site's
   *  dashboard can read what the gate would have done. */
  detail: string;
}

const isAction = (v: unknown): v is OperatorAction => (OPERATOR_ACTIONS as readonly unknown[]).includes(v);

/**
 * The policy as the control plane sent it, reduced to what this gate can
 * apply: a rule with a value this gate does not know (a newer operator id, an
 * action it has no branch for) is dropped rather than guessed at, and an
 * unknown default is "charge". `null` when the view carries no policy at all
 * — an older control plane — so the gate decides as it always has.
 */
export function normalizeOperatorPolicy(raw: unknown): OperatorPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const view = raw as { operator_rules?: unknown; operator_default?: unknown };
  if (!Array.isArray(view.operator_rules)) return null;
  const operator_rules: OperatorRule[] = [];
  const seen = new Set<string>();
  for (const item of view.operator_rules) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const hasOperator = r.operator != null;
    const hasClass = r.ua_class != null;
    if (hasOperator === hasClass || !isAction(r.action)) continue;
    if (hasOperator && !(GATE_OPERATORS as readonly unknown[]).includes(r.operator)) continue;
    if (hasClass && (r.ua_class === "human" || !(UA_CLASSES as readonly unknown[]).includes(r.ua_class))) continue;
    const key = hasOperator ? `operator:${String(r.operator)}` : `ua_class:${String(r.ua_class)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    operator_rules.push({
      ...(hasOperator
        ? { operator: r.operator as OperatorRule["operator"] }
        : { ua_class: r.ua_class as OperatorRule["ua_class"] }),
      action: r.action,
      verified_only: r.verified_only === true,
    });
  }
  return {
    operator_rules,
    operator_default: isAction(view.operator_default) ? view.operator_default : OPERATOR_DEFAULT,
  };
}

/**
 * The action for a classified caller. Order: the rule for its operator, the
 * rule for its class, the default — skipping any `verified_only` rule while
 * `who.verified` is false. Pure: call it again once the receipt verified.
 */
export function decideOperator(policy: OperatorPolicy | null | undefined, who: AgentIdentity): OperatorDecision {
  const none: OperatorDecision = { action: "charge", matched: "none", rule: null, detail: "operator policy: none" };
  if (!policy || who.ua_class === "human") return none;
  const rules = Array.isArray(policy.operator_rules) ? policy.operator_rules : [];
  const applies = (r: OperatorRule) => r.verified_only !== true || who.verified === true;
  const byOperator = rules.find((r) => r.operator != null && r.operator === who.operator);
  if (byOperator && isAction(byOperator.action) && applies(byOperator)) {
    return {
      action: byOperator.action,
      matched: "operator",
      rule: byOperator,
      detail: `operator policy: ${byOperator.action} (operator=${byOperator.operator})`,
    };
  }
  const byClass = rules.find((r) => r.ua_class != null && r.ua_class === who.ua_class);
  if (byClass && isAction(byClass.action) && applies(byClass)) {
    return {
      action: byClass.action,
      matched: "ua_class",
      rule: byClass,
      detail: `operator policy: ${byClass.action} (ua_class=${byClass.ua_class})`,
    };
  }
  const action = isAction(policy.operator_default) ? policy.operator_default : OPERATOR_DEFAULT;
  return { action, matched: "default", rule: null, detail: `operator policy: ${action} (default)` };
}
