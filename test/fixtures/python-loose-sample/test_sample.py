"""The offline test gate for the loose Python pin-then-pure path (laimk-hse.5).

After dustcastle resolves the loose requirements.in into a hash-pinned
requirements.txt and provisions PURE via the pip-FOD, the two deps must import
from the Store-staged site-packages entirely offline.
"""

import idna
import urllib3


def test_idna_encodes_unicode_host():
    assert idna.encode("ドメイン.テスト") == b"xn--eckwd4c7c.xn--zckzah"


def test_urllib3_is_importable():
    assert urllib3.__version__.startswith("2.")
