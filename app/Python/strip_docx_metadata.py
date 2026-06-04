"""Compatibility shim — strip_docx_metadata.py moved to ingestion/word/strip_docx_metadata.py (Phase 2 reorg: folders mirror the decision tree).
The live backend invokes THIS path and tests import it, so this re-export keeps both working. Real
code: ingestion/word/strip_docx_metadata.py."""
if __name__ == '__main__':                         # PHP runs `python3 app/Python/strip_docx_metadata.py` — delegate only
    import runpy
    runpy.run_module('ingestion.word.strip_docx_metadata', run_name='__main__')
else:                                              # imported by name (`import strip_docx_metadata`) — mirror the namespace
    from ingestion.word.strip_docx_metadata import *          # noqa: F401,F403
    import importlib as _il
    _real = _il.import_module('ingestion.word.strip_docx_metadata')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
