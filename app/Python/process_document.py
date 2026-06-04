"""Compatibility shim — process_document.py moved to digestion/process_document.py (Phase 2 reorg: folders mirror the decision tree).
The live backend invokes THIS path and tests import it, so this re-export keeps both working. Real
code: digestion/process_document.py."""
if __name__ == '__main__':                         # PHP runs `python3 app/Python/process_document.py` — delegate only
    import runpy
    runpy.run_module('digestion.process_document', run_name='__main__')
else:                                              # imported by name (`import process_document`) — mirror the namespace
    from digestion.process_document import *          # noqa: F401,F403
    import importlib as _il
    _real = _il.import_module('digestion.process_document')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
