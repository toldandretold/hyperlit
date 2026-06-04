"""Compatibility shim — ar5iv_preprocessor.py moved to ingestion/html/ar5iv_preprocessor.py (Phase 2 reorg: folders mirror the decision tree).
The live backend invokes THIS path and tests import it, so this re-export keeps both working. Real
code: ingestion/html/ar5iv_preprocessor.py."""
if __name__ == '__main__':                         # PHP runs `python3 app/Python/ar5iv_preprocessor.py` — delegate only
    import runpy
    runpy.run_module('ingestion.html.ar5iv_preprocessor', run_name='__main__')
else:                                              # imported by name (`import ar5iv_preprocessor`) — mirror the namespace
    from ingestion.html.ar5iv_preprocessor import *          # noqa: F401,F403
    import importlib as _il
    _real = _il.import_module('ingestion.html.ar5iv_preprocessor')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
