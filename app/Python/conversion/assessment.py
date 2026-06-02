"""The conversion decision-trace collector.

Shared module so every extracted pipeline module records to the SAME instance, and the
orchestrator dumps one assessment.json spanning the whole run. See process_document.py.
"""

import json
import os


class Assessment:
    """Structured decision-trace of WHAT the conversion pipeline decided, in which
    MODULE, and WHY — written to assessment.json alongside conversion_stats.json and
    audit.json. Each record names the responsible code (code_ref = file:function, or a
    detector class) so a human OR an LLM can jump straight to the module that owns a
    decision and what to change. Purely diagnostic: recording never alters conversion
    behaviour, so it cannot change nodes/footnotes/references/audit output."""

    def __init__(self):
        self.records = []

    def reset(self, seed_dir=None):
        """Start fresh. If seed_dir holds an assessment.json from an upstream stage
        (e.g. epub_normalizer.py records which detector fired), adopt those records
        first so the final trace spans the whole pipeline, not just process_document."""
        self.records = []
        if seed_dir:
            seed = os.path.join(seed_dir, 'assessment.json')
            if os.path.isfile(seed):
                try:
                    existing = json.load(open(seed, encoding='utf-8')).get('records', [])
                    self.records = [dict(r, seq=i) for i, r in enumerate(existing)]
                except Exception:
                    pass

    def record(self, module, code_ref, decision, rationale, evidence=None):
        self.records.append({
            'seq': len(self.records),
            'module': module,
            'code_ref': code_ref,
            'decision': decision,
            'rationale': rationale,
            'evidence': evidence or {},
        })

    def dump(self, output_dir):
        try:
            with open(os.path.join(output_dir, 'assessment.json'), 'w', encoding='utf-8') as f:
                json.dump({'records': self.records}, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Warning: could not write assessment.json: {e}")


# Module-level collector; reset at the start of main(), dumped before it returns.
ASSESSMENT = Assessment()
