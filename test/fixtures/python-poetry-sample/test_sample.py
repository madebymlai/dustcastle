"""The offline test gate for the poetry front-end → pip-FOD path (laimk-hse.7).

Same gate as python-sample/python-uv-sample: imports the two deps that poetry.lock
pinned (and that `poetry export` materialises into requirements.txt for the pip-FOD),
asserting a trivial fact about each, so `python -m pytest` proves the deps are present
and importable entirely offline from the Store-staged site-packages.

The laimk-hse.7 spike proved `poetry export` hermetic, so the provisionGate is dropped
and this runs the real offline-pytest build (like the uv case), not a gate assertion.
"""

import idna
import urllib3


def test_idna_encodes_unicode_host():
    # idna is a pure-Python wheel; a round-trip proves it imported and works.
    assert idna.encode("ドメイン.テスト") == b"xn--eckwd4c7c.xn--zckzah"


def test_urllib3_is_importable():
    # urllib3 exposes its version; importing it offline is the real assertion.
    assert urllib3.__version__.startswith("2.")
