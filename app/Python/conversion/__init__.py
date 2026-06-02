"""Modular conversion pipeline pieces extracted from the process_document.py monolith.

Each module owns one responsibility and is independently unit-testable, so a decision in
the pipeline's assessment.json trace maps to an addressable module here. The orchestrator
(process_document.py) imports from this package; run as `python3 app/Python/process_document.py`
the package resolves because app/Python is on sys.path[0].
"""
