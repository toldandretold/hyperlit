"""Compatibility shim — mistral_ocr.py moved to ingestion/pdf/mistral_ocr.py (Phase 2 reorg: folders mirror the decision tree).
The live backend invokes THIS path and tests import it, so this re-export keeps both working. Real
code: ingestion/pdf/mistral_ocr.py."""
if __name__ == '__main__':                         # PHP runs `python3 app/Python/mistral_ocr.py` — delegate only
    import runpy
    runpy.run_module('ingestion.pdf.mistral_ocr', run_name='__main__')
else:                                              # imported by name (`import mistral_ocr`) — mirror the namespace
    from ingestion.pdf.mistral_ocr import *          # noqa: F401,F403
    import importlib as _il
    _real = _il.import_module('ingestion.pdf.mistral_ocr')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
