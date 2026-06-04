"""Compatibility shim — epub_normalizer.py moved to ingestion/epub/epub_normalizer.py (Phase 2 reorg: folders mirror the decision tree).
The live backend invokes THIS path and tests import it, so this re-export keeps both working. Real
code: ingestion/epub/epub_normalizer.py."""
if __name__ == '__main__':                         # PHP runs `python3 app/Python/epub_normalizer.py` — delegate only
    import runpy
    runpy.run_module('ingestion.epub.epub_normalizer', run_name='__main__')
else:                                              # imported by name (`import epub_normalizer`) — mirror the namespace
    from ingestion.epub.epub_normalizer import *          # noqa: F401,F403
    import importlib as _il
    _real = _il.import_module('ingestion.epub.epub_normalizer')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
