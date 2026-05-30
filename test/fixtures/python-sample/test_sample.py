"""The offline test gate for the Python pip-FOD tracer (laimk-hse.2).

Imports the two pinned deps from the Store-staged site-packages and asserts a
trivial fact about each, so `python -m pytest` proves the deps are present and
importable entirely offline.
"""

import idna
import urllib3


def test_idna_encodes_unicode_host():
    # idna is a pure-Python wheel; a round-trip proves it imported and works.
    assert idna.encode("ドメイン.テスト") == b"xn--eckwd4c7c.xn--zckzah"


def test_urllib3_is_importable():
    # urllib3 exposes its version; importing it offline is the real assertion.
    assert urllib3.__version__.startswith("2.")
