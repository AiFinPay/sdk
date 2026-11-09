"""A receipt carries the content licence it was bought under (``lic``,
AIFINP-262). The gate sends it with the content that receipt unlocked, only then."""

import aifinpay_gate as g
from aifinpay_gate.license import license_headers, receipt_license
from test_gate import MID, gate, req, token

LIC = {"id": "clic_" + "ab" * 12, "rev": 2, "v": "2.0", "sha256": "3" * 64, "confirmed": True}
URL = f"https://api.aifinpay.io/v1/merchants/{MID}/license/2"


def test_a_paid_answer_carries_the_licence_from_the_receipt():
    r = gate().decide(req(token(lic=LIC)))
    assert r.ok
    assert r.headers["AIFP-License"] == f'id={LIC["id"]}; rev=2; sha256={LIC["sha256"]}; url="{URL}"'
    assert r.headers["Link"] == f'<{URL}/text>; rel="license"'
    assert r.aifp["license"] == LIC


def test_a_receipt_without_a_licence_adds_nothing():
    r = gate().decide(req(token()))
    assert r.ok and "AIFP-License" not in r.headers and "license" not in r.aifp


def test_a_refusal_never_carries_it():
    assert "AIFP-License" not in gate().decide(req()).headers
    other = gate().decide(req(token(lic=LIC, aud="mrch_other")))
    assert other.status == 403 and "AIFP-License" not in other.headers


def test_the_url_is_the_gates_own_whatever_the_token_says():
    r = gate(api_base="https://api.example.test/").decide(req(token(lic={**LIC, "url": "https://evil.example"})))
    assert f'url="https://api.example.test/v1/merchants/{MID}/license/2"' in r.headers["AIFP-License"]
    assert "evil" not in r.headers["AIFP-License"]


def test_a_malformed_claim_is_ignored():
    for bad in (None, "x", {}, {**LIC, "id": "lic_1"}, {**LIC, "rev": 0}, {**LIC, "rev": True}, {**LIC, "sha256": "Z" * 64}):
        assert receipt_license(bad) is None
    assert license_headers("https://api.aifinpay.io", MID, None) == {}
    assert g.Gate
