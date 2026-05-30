"""The offline test gate for the Python uv front-end → pip-FOD path (laimk-hse.6).

Same gate as python-sample: imports the two deps that uv.lock pinned (and the uv
export front-end materialised into requirements.txt for the pip-FOD), asserting a
trivial fact about each, so `python -m pytest` proves the deps are present and
importable entirely offline from the Store-staged site-packages.
"""

import idna
import urllib3


def test_idna_encodes_unicode_host():
    # idna is a pure-Python wheel; a round-trip proves it imported and works.
    assert idna.encode("ドメイン.テスト") == b"xn--eckwd4c7c.xn--zckzah"


def test_urllib3_is_importable():
    # urllib3 exposes its version; importing it offline is the real assertion.
    assert urllib3.__version__.startswith("2.")
