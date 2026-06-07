"""Phase 2 reorg gate — the folders ARE the decision tree, and the compatibility shims keep the live
backend working. Asserts: (1) every old flat path the backend invokes still resolves to its moved
module (the shim mirrors the real namespace), (2) the new ingestion/digestion/shared structure +
READMEs exist with the real modules at their new homes, (3) the conversion/ package is emptied down to
its remaining members (no leftover compat shims). If a move breaks a backend path or a README goes
missing, this fails loudly — the same protection that lets the live import keep calling the old paths."""
import glob
import importlib
import os

import pytest

_HERE = os.path.dirname(__file__)
_PY = os.path.abspath(os.path.join(_HERE, '..', '..', '..', 'app', 'Python'))

# old flat path (module name the backend/tests use) -> (new dotted module, a symbol that must be the
# SAME object through the shim — proves the shim mirrors, not merely imports).
_SHIM_MAP = {
    'mistral_ocr': ('ingestion.pdf.mistral_ocr', 'PDF_CLASSIFIERS'),
    'epub_normalizer': ('ingestion.epub.epub_normalizer', 'EpubNormalizer'),
    'ar5iv_preprocessor': ('ingestion.html.ar5iv_preprocessor', 'main'),
    'strip_docx_metadata': ('ingestion.word.strip_docx_metadata', 'main'),
    'simple_md_to_html': ('ingestion.markdown_and_pdf_to_html.simple_md_to_html', 'main'),
    'process_document': ('digestion.process_document', 'run_passes'),
    'vibe_convert': ('vibeConverter.cli', 'main'),
}


@pytest.mark.parametrize('old,target', list(_SHIM_MAP.items()), ids=list(_SHIM_MAP))
def test_backend_entry_shim_resolves_to_moved_module(old, target):
    new_mod, sym = target
    shim = importlib.import_module(old)
    real = importlib.import_module(new_mod)
    assert getattr(shim, sym) is getattr(real, sym), f"{old} shim does not mirror {new_mod}.{sym}"


def test_backend_entry_shims_exist_and_are_marked_shims():
    for old in _SHIM_MAP:
        p = os.path.join(_PY, old + '.py')
        assert os.path.isfile(p), f"backend entry shim missing (live app invokes this path): {p}"
        assert 'Compatibility shim' in open(p, encoding='utf-8').read(300), f"{old}.py is not a shim"


def test_structure_and_readmes_exist():
    for stage in ('ingestion', 'digestion', 'shared'):
        d = os.path.join(_PY, stage)
        assert os.path.isdir(d), f"missing package: {stage}/"
        assert os.path.isfile(os.path.join(d, 'README.md')), f"missing {stage}/README.md"
    # the moved real modules live at their new homes (one representative per band)
    for rel in ('ingestion/pdf/mistral_ocr.py', 'ingestion/epub/epub_normalizer.py',
                'digestion/process_document.py', 'digestion/strategySelection/strategy.py',
                'digestion/finalAudit/audit.py', 'shared/assessment.py'):
        assert os.path.isfile(os.path.join(_PY, rel)), f"moved module missing at its new home: {rel}"


def test_conversion_package_emptied_to_remaining_members():
    remaining = {os.path.basename(p) for p in glob.glob(os.path.join(_PY, 'conversion', '*.py'))}
    assert remaining == {'__init__.py', 'fix_categories.py'}, (
        "conversion/ should hold only __init__ + fix_categories after the reorg (the migrated modules' "
        f"compat shims are deleted in 2c) — found: {sorted(remaining)}")
