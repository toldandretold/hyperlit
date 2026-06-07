#!/usr/bin/env python3
"""Compatibility shim — vibe_convert.py was split into the vibeConverter/ package (folders mirror the
loop's stages, like ingestion/digestion). The live backend invokes THIS path
(`python3 app/Python/vibe_convert.py …`) and many modules + tests do `import vibe_convert as v/vc`, so
this re-export keeps both working. Real code: app/Python/vibeConverter/.

  • run as __main__  → delegate to vibeConverter.cli via runpy (so the package runs as the program).
  • imported by name → mirror the package's full namespace (incl. single-underscore names) into here, and
    expose `runtime` (the live mutable-state module) so callers read e.g. vibe_convert.runtime._DOCKER_IMAGE.
"""
if __name__ == '__main__':
    import runpy
    runpy.run_module('vibeConverter.cli', run_name='__main__')
else:
    import importlib as _il
    _real = _il.import_module('vibeConverter')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
    runtime = _il.import_module('vibeConverter.runtime')   # the LIVE mutable-state module (not a stale copy)
