# shared/ — cross-cutting helpers used by BOTH ingestion and digestion

Not a pipeline stage — the utilities every stage leans on:

- `assessment.py` — the decision-trace collector (`ASSESSMENT` → `assessment.json`); the single
  instance every stage records to (its singleton identity is preserved across the compat shims).
- `refkeys.py` — citation-key generation + `is_likely_reference`.
- `sanitize.py` — HTML / URL sanitisation (bleach).
- `pipeline_base.py` — `DocPass` + `run_passes` (the orchestration base classes).
- `link_base.py` — `LinkRule` + `run_link_rules` (the linking base classes).

These moved out of the old flat `conversion/` package; thin re-export shims remain at
`app/Python/conversion/<name>.py` so existing `from conversion.X import Y` callers keep working until
they're migrated to `from shared.X import Y`.
