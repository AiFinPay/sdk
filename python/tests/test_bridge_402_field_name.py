"""agent.call() must understand the 402 a REAL bridge sends.

The production bridges renamed their payment block ``pay_matic`` ->
``pay_native`` on 2026-08-04, when the on-chain entrypoint became ``payNative``.
This SDK kept reading only ``pay_matic``, so ``call(provider=...)`` failed
against every live bridge with an error blaming facilitator wiring. AIFINP-118.

It survived because the bridge tests built their 402 fixtures in the SDK's own
vocabulary — both sides of every assertion came from this repository, so
renaming the field on the server broke nothing here. The fixture below is the
verbatim body of a production 402, captured with curl on 2026-08-13 and
committed unedited. Values (order ids, live POL pricing) are dynamic; the shape
is the contract.
"""

import json
from pathlib import Path

from aifinpay.unified_agent import native_pay_block

FIXTURE = Path(__file__).parent / "fixtures" / "bridge-402-io-net-2026-08-13.json"
LIVE = json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_still_has_the_shape_this_test_assumes():
    # Guard the guard: a re-captured fixture from a bridge that changed shape
    # again should fail HERE, with a message that says what happened.
    assert "pay_native" in LIVE
    assert "pay_matic" not in LIVE  # the old name is genuinely gone


def test_live_402_is_accepted_by_the_exact_function_call_uses():
    pm = native_pay_block(LIVE)
    assert pm is not None
    # The fields _settle_polygon consumes downstream.
    assert pm["splitter"].startswith("0x") and len(pm["splitter"]) == 42
    assert pm["merchant_wallet"].startswith("0x")
    assert int(pm["total_wei"]) > 0
    assert pm["order_id"]
    assert pm["chain"] == "polygon"


def test_legacy_pay_matic_only_bridge_still_works():
    # Old bridges exist until every deployment is redeployed; dropping the old
    # name would recreate this whole incident in the other direction.
    pm = native_pay_block({"pay_matic": {"order_id": "legacy"}})
    assert pm == {"order_id": "legacy"}


def test_pay_native_wins_when_a_bridge_sends_both():
    pm = native_pay_block(
        {"pay_native": {"order_id": "new"}, "pay_matic": {"order_id": "old"}}
    )
    assert pm == {"order_id": "new"}


def test_neither_returns_none_so_the_error_can_name_the_real_problem():
    assert native_pay_block({"error": "Payment Required"}) is None
