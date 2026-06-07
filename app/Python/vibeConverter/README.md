# vibeConverter — the vibe self-improving conversion loop

This package is the brain of the "vibe conversion" feature: given a book whose conversion is faulty, it
diagnoses the failure, asks an LLM for a minimal patch to the *conversion pipeline*, tests that patch in a
throwaway sandbox against THIS document, and — if it genuinely improves the result — applies it. Production
code is never touched directly; only this book's regenerated artifacts are.

It was split out of the former 2188-line `app/Python/vibe_convert.py` monolith (folders mirror the loop's
stages, exactly like `ingestion/` and `digestion/`). The old path `vibe_convert.py` is now a thin
**re-export shim** (runpy-delegates to `cli` when run as the program; mirrors the full namespace when
imported), so the live backend (`VibeConversionJob.php`) and every `import vibe_convert` keep working.

## The stages (dependencies flow upward from the leaf)

| File | Job |
|---|---|
| `runtime.py` | **Zero-import leaf.** Constants, env/price helpers, and the MUTABLE run state (`_USAGE` + the CLI-set `_PROGRESS_FILE`/`_CANCEL_FILE`/`_JSON_PROGRESS`/`_DOCKER_IMAGE`). `emit()`/`_cancelled()` read this module's own globals; `cli` writes them once via `configure()`. |
| `artifacts.py` | Read a failing conversion's `assessment.json`/`audit.json`/stats/source → the `art` dict everything keys off. |
| `diagnosis.py` | Decide which assessment forks are real problems (the LLM's leads). |
| `routing.py` | **What code to send the model** + how to narrate the problem. The issue→module map, the pathway-aware footnote-detector routing (EPUB→`footnoteMatching.py`, PDF→`classification.py`+`assembly.py`, else→`process_document.py`), and the per-issue narration. |
| `samplers.py` | Pull the ACTUAL marker/definition/reference evidence from the document — file-type aware (EPUB `<sup>`/noteref schemes, PDF `[^N]`). This is what lets "footnotes not matched" show the model the markup it missed. |
| `prompt.py` | Assemble the diagnostic prompt both engines (native + aider) send. |
| `propose.py` | Get a candidate patch from the LLM (Fireworks). |
| `patch.py` | Validate + apply the patch (full-function / `op:edit` / `op:add` / `op:register`) via the AST engine. |
| `sandbox.py` | Throwaway repo copy + pathway-aware re-conversion of THIS book. |
| `gate.py` | The accept/reject gate (clean / improved / reject) + best-of-N over retries. |
| `report.py` | Persist the winning patch, finalise the run report, file a GitHub issue on an unfixed run. |
| `loop.py` | The user-facing bounded-retry orchestrator (`run_loop`). |
| `apply.py` | "Use this conversion": apply the patch + regenerate this book's artifacts. |
| `cli.py` | Argument parsing + dispatch (the entry the shim delegates to). |

## Testing what gets sent to the model

`tests/conversion/unit/test_vibe_routing_matrix.py` is the matrix: for each (issue type × file type) it pins
the modules routed (`routing.modules_for`), the prompt sections that fire (`prompt.build_prompt`), and the
evidence the samplers surface. `test_vibe_*` and `test_issue_routing` cover the gate, the AST patch engine,
flagging, and node-help. `test_pipeline_layout.py` proves the `vibe_convert.py` shim still mirrors the
package.
