"""Per-operator access policy — allow / charge / block, decided by the merchant.

A port of gate/src/operator-policy.ts, with the same precedence as
backend/app/aifp/policy.js ``decideOperator``: the rule for the caller's
operator, then the rule for its class, then ``operator_default`` — skipping any
``verified_only`` rule while the caller's identity is a claim. Readers
(``ua_class: human``) are never matched; who pays on a page with human readers
is the gate's ``should_charge``. ``charge`` is the gate's own decision and the
default, so a policy without rules changes nothing.
"""

from typing import Any, Dict, Optional

from .agents import GATE_OPERATORS, UA_CLASSES

OPERATOR_ACTIONS = ("allow", "charge", "block")
OPERATOR_DEFAULT = "charge"
_NONE = {"action": "charge", "matched": "none", "rule": None, "detail": "operator policy: none"}


def normalize_operator_policy(raw: Any) -> Optional[Dict[str, Any]]:
    """The policy as the control plane sent it, reduced to what this gate can
    apply: a rule with a value this gate does not know is dropped rather than
    guessed at, an unknown default is ``charge``. ``None`` when the view
    carries no policy at all, so the gate decides as it always has."""
    if not isinstance(raw, dict) or not isinstance(raw.get("operator_rules"), list):
        return None
    rules = []
    seen = set()
    for item in raw["operator_rules"]:
        if not isinstance(item, dict):
            continue
        has_operator = item.get("operator") is not None
        has_class = item.get("ua_class") is not None
        if has_operator == has_class or item.get("action") not in OPERATOR_ACTIONS:
            continue
        if has_operator and item["operator"] not in GATE_OPERATORS:
            continue
        if has_class and (item["ua_class"] == "human" or item["ua_class"] not in UA_CLASSES):
            continue
        key = ("operator", item["operator"]) if has_operator else ("ua_class", item["ua_class"])
        if key in seen:
            continue
        seen.add(key)
        rule = {"operator": item["operator"]} if has_operator else {"ua_class": item["ua_class"]}
        rule["action"] = item["action"]
        rule["verified_only"] = item.get("verified_only") is True
        rules.append(rule)
    default = raw.get("operator_default")
    return {"operator_rules": rules, "operator_default": default if default in OPERATOR_ACTIONS else OPERATOR_DEFAULT}


def decide_operator(policy: Optional[Dict[str, Any]], who: Dict[str, Any]) -> Dict[str, Any]:
    """The action for a classified caller: ``{action, matched, rule, detail}``.
    Pure — call it again once the receipt verified."""
    if not policy or who.get("ua_class") == "human":
        return dict(_NONE)
    rules = policy.get("operator_rules") or []
    verified = who.get("verified") is True

    def applies(rule):
        return rule.get("verified_only") is not True or verified

    for rule in rules:
        if rule.get("operator") is not None and rule["operator"] == who.get("operator"):
            if rule.get("action") in OPERATOR_ACTIONS and applies(rule):
                return {"action": rule["action"], "matched": "operator", "rule": rule,
                        "detail": f"operator policy: {rule['action']} (operator={rule['operator']})"}
            break
    for rule in rules:
        if rule.get("ua_class") is not None and rule["ua_class"] == who.get("ua_class"):
            if rule.get("action") in OPERATOR_ACTIONS and applies(rule):
                return {"action": rule["action"], "matched": "ua_class", "rule": rule,
                        "detail": f"operator policy: {rule['action']} (ua_class={rule['ua_class']})"}
            break
    action = policy.get("operator_default")
    if action not in OPERATOR_ACTIONS:
        action = OPERATOR_DEFAULT
    return {"action": action, "matched": "default", "rule": None, "detail": f"operator policy: {action} (default)"}
