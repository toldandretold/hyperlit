"""vibeConverter — the vibe-conversion loop, split by concern (mirrors ingestion/digestion).
Aggregates every submodule's public + single-underscore names so `from vibeConverter import *`
and the vibe_convert.py shim expose the full historical namespace."""
import importlib
_MODS = ['runtime', 'artifacts', 'diagnosis', 'routing', 'samplers', 'prompt', 'propose',
         'patch', 'sandbox', 'gate', 'report', 'apply', 'loop', 'cli']
for _m in _MODS:
    _mod = importlib.import_module('vibeConverter.' + _m)
    globals().update({_k: _v for _k, _v in vars(_mod).items() if not _k.startswith('__')})
