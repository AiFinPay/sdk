"""The tables in agents.py are generated from the packaged data/agents-v1.json, a byte copy of gate/data/agents-v1.json."""

import json
import pathlib

import pytest

import aifinpay_gate as g

PACKAGED = pathlib.Path(g.__file__).parent / "data" / "agents-v1.json"
CANONICAL = pathlib.Path(__file__).resolve().parents[2] / "gate" / "data" / "agents-v1.json"
DATA = json.loads(PACKAGED.read_text())


def test_tables_are_the_packaged_file():
    assert list(g.GATE_OPERATORS) == [o["id"] for o in DATA["operators"]]
    assert list(g.UA_CLASSES) == DATA["ua_classes"]
    assert [list(r) for r in g.AI_AGENT_UA_TABLE] == [[e["marker"], e["operator"], e["ua_class"]] for e in DATA["entries"] if e["ua"]]
    assert [list(r) for r in g.ROBOTS_TOKENS] == [[e["token"], e["operator"], e["ua_class"]] for e in DATA["entries"] if e["robots"]]


@pytest.mark.skipif(not CANONICAL.exists(), reason="no sibling gate checkout")
def test_packaged_file_is_a_byte_copy_of_the_gate_file():
    assert PACKAGED.read_bytes() == CANONICAL.read_bytes()
