"""pytest setup for the conversion unit tests.

Imported by pytest before collecting tests in this dir, so the sys.path insert makes
the `conversion` package importable at test-module import time. Provides a `soup`
fixture for building BeautifulSoup trees.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'app', 'Python')))

import pytest
from bs4 import BeautifulSoup


@pytest.fixture
def soup():
    def _make(html):
        return BeautifulSoup(html, 'html.parser')
    return _make
