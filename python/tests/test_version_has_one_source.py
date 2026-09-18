"""The package has one version, and it is the one that gets published.

`aifinpay/__init__.py` used to carry `__version__ = "2.0.0rc1"` while
pyproject.toml said 2.1.0. Both are user-visible — `pip show` reads one,
`aifinpay.__version__` returned the other — and the wrong one was the one a
user can print from their own process. pyproject.toml is what is built and
uploaded, so it is the version; __init__ now reads the installed metadata.

These keep it that way.
"""

import pathlib
import re

import aifinpay

PYPROJECT = pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"
INIT = pathlib.Path(aifinpay.__file__)


def _declared_version() -> str:
    """The version pyproject.toml declares, read without tomllib.

    tomllib arrives in 3.11 and this package supports 3.9, so a regex keeps the
    test runnable everywhere the package claims to run.
    """
    text = PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
    assert match, "pyproject.toml declares no version"
    return match.group(1)


def test_the_runtime_version_is_the_published_one():
    declared = _declared_version()
    assert aifinpay.__version__ == declared, (
        f"aifinpay.__version__ is {aifinpay.__version__!r} and pyproject.toml says "
        f"{declared!r}. If the package is installed from this checkout, reinstall it "
        f"(`pip install -e .`); otherwise the two have drifted apart again."
    )


def test_no_second_version_is_written_in_the_source():
    """A literal here is how the two drifted apart in the first place."""
    source = INIT.read_text(encoding="utf-8")
    assigned = re.findall(r'(?m)^__version__\s*=\s*["\']([^"\']+)["\']', source)
    plausible = [v for v in assigned if re.match(r"^\d+\.\d+", v)]
    assert not plausible, (
        f"__init__.py assigns a version literal {plausible!r}. The version belongs in "
        "pyproject.toml; read it from the installed metadata instead."
    )


def test_an_uninstalled_checkout_says_unknown_rather_than_guessing():
    """The fallback must not look like a real version.

    Running from a source tree that was never installed leaves no metadata to
    read. Answering with a plausible number there would be a confident wrong
    answer; "0+unknown" is an obviously absent one.
    """
    source = INIT.read_text(encoding="utf-8")
    assert '"0+unknown"' in source or "'0+unknown'" in source
