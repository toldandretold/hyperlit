"""Gate: prod-case fixtures in the COMMITTABLE tree must carry a permissive-license stamp.

A case fixture's ocr_response.json is the FULL TEXT of a real published work, so committing it
to the public repo is redistribution. `book:import-cases` routes by license
(App\\Services\\Conversion\\FixtureLicenseGate): permissive works -> fixtures/ with a
`license: … -> committable` manifest stamp; everything else -> the git-ignored fixtures-local/
twin. This test is the backstop for the manual path — a fixture hand-copied or hand-authored
into fixtures/ from a real book without a committable license stamp fails here.

Synthetic / hand-made pathway fixtures (the pdf/, epub/, docx/, html/, md/, strategy/ subtrees)
are exempt: their content is constructed or long-cleared test material, not a pulled prod book.
"""

import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.abspath(os.path.join(HERE, '..', 'fixtures'))

# Pulled prod cases are named by book id (uuid). Pathway subtrees are curated by hand.
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


class FixtureLicenseGateTest(unittest.TestCase):
    def test_committed_prod_case_fixtures_declare_committable_license(self):
        offenders = []
        for name in sorted(os.listdir(FIXTURES_DIR)):
            if not UUID_RE.match(name):
                continue
            manifest_path = os.path.join(FIXTURES_DIR, name, 'manifest.json')
            if not os.path.isfile(manifest_path):
                offenders.append(f'{name}: no manifest.json')
                continue
            manifest = json.load(open(manifest_path, encoding='utf-8'))
            license_note = manifest.get('license', '')
            if '-> committable' not in license_note:
                offenders.append(
                    f"{name}: manifest.license is {license_note!r} — a prod-case fixture in the "
                    f"committable tree must be stamped '… -> committable' (permissive license). "
                    f"Non-permissive/unknown works belong in tests/conversion/fixtures-local/."
                )
        self.assertEqual([], offenders,
                         'Committable-tree fixtures without a permissive-license stamp:\n  '
                         + '\n  '.join(offenders))


if __name__ == '__main__':
    unittest.main()
