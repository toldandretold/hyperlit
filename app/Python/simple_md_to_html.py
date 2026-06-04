"""Compatibility shim — simple_md_to_html.py moved to ingestion/markdown_and_pdf_to_html/simple_md_to_html.py (Phase 2 reorg: folders mirror the decision tree).
The live backend invokes THIS path and tests import it, so this re-export keeps both working. Real
code: ingestion/markdown_and_pdf_to_html/simple_md_to_html.py."""
if __name__ == '__main__':                         # PHP runs `python3 app/Python/simple_md_to_html.py` — delegate only
    import runpy
    runpy.run_module('ingestion.markdown_and_pdf_to_html.simple_md_to_html', run_name='__main__')
else:                                              # imported by name (`import simple_md_to_html`) — mirror the namespace
    from ingestion.markdown_and_pdf_to_html.simple_md_to_html import *          # noqa: F401,F403
    import importlib as _il
    _real = _il.import_module('ingestion.markdown_and_pdf_to_html.simple_md_to_html')
    globals().update({k: v for k, v in vars(_real).items() if not k.startswith('__')})
