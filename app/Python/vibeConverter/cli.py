"""vibeConverter.cli — argument parsing + dispatch. The vibe_convert.py shim delegates here via
runpy when the live backend runs `python3 app/Python/vibe_convert.py …`."""
import argparse
import json
import os
import sys

from vibeConverter import runtime
from vibeConverter.artifacts import load_artifacts
from vibeConverter.diagnosis import flagged_forks
from vibeConverter.routing import modules_for
from vibeConverter.prompt import build_prompt
from vibeConverter.loop import run_loop
from vibeConverter.apply import apply_patch_to_book


def main():
    ap = argparse.ArgumentParser(description="LLM vibe-conversion harness — the user path "
                                             "(bounded retry, this-document success gate).")
    ap.add_argument('book_dir', help="Directory holding the faulty conversion's artifacts.")
    ap.add_argument('--max-attempts', type=int, default=3, help="Retry cutoff (default 3).")
    ap.add_argument('--mock-diff', help="Use this diff file instead of the LLM (single attempt).")
    ap.add_argument('--print-prompt', action='store_true', help="Print the prompt and exit.")
    ap.add_argument('--model', default=None,
                    help="LLM model id via Fireworks. Unset → each engine's default (deepseek: V4 Pro; "
                         "aider: gpt-oss-120b). Pass it to A/B the SAME model across both engines.")
    ap.add_argument('--user-note', help="The reader's own description of what's wrong (fed to the model).")
    ap.add_argument('--issue-types', type=json.loads, default=None,
                    help='JSON array of the reader\'s structured issue categories (citations_not_matched, '
                         'citations_wrongly_matched, footnotes_not_matched, footnotes_wrongly_matched, '
                         'headings_wrong) — routes the relevant modules + a per-category gloss to the model.')
    ap.add_argument('--prompt-variant', choices=['full', 'lean'], default=None,
                    help="Prompt CONTENT variant to A/B: 'full' (default — includes the fix-category menu) "
                         "or 'lean' (drops the menu, relying on the self-describing pipeline tree).")
    ap.add_argument('--json-progress', action='store_true',
                    help="Emit VIBE:{json} progress lines for the SSE controller to stream.")
    ap.add_argument('--progress-file', help="Append each progress beat (JSON line) here for polling.")
    ap.add_argument('--cancel-file', help="Stop at the next attempt boundary if this file appears.")
    ap.add_argument('--docker', metavar='IMAGE',
                    help="Run the re-conversion (model code) in this locked-down container image "
                         "(no network/secrets). Recommended on prod, e.g. hyperlit-vibe-sandbox.")
    ap.add_argument('--github', action='store_true',
                    help="On an UNFIXED run, open a GitHub issue with the full diagnosis "
                         "(uses GITHUB_TOKEN from .env; dry-runs if absent).")
    ap.add_argument('--apply', metavar='PATCH',
                    help="'Use this conversion': apply PATCH + regenerate this book's artifacts.")
    ap.add_argument('--engine', choices=['native', 'aider'], default='native',
                    help="Edit-gen engine (NOT a model — runs whatever --model you pass): 'native' (our "
                         "full-function-JSON loop, default) or 'aider' "
                         "(repo-map + search/replace + test-driven retry; needs VIBE_AIDER_BIN).")
    args = ap.parse_args()

    # ONE canonical write of the CLI-controlled run state — into vibeConverter.runtime, the single module
    # object every importer (incl. vibe_aider via the vibe_convert shim) shares. This REPLACES the old
    # "mirror the globals onto the imported module" hack: emit()/_cancelled()/_pipeline_into read these
    # via runtime, so the aider path's progress beats land without any per-module mirroring.
    runtime.configure(progress_file=args.progress_file, cancel_file=args.cancel_file,
                      json_progress=args.json_progress, docker=args.docker)
    if args.prompt_variant:
        os.environ['VIBE_PROMPT_VARIANT'] = args.prompt_variant   # read by build_diagnostic_context

    if args.apply:
        sys.exit(apply_patch_to_book(args.book_dir, args.apply))

    if args.print_prompt:
        art = load_artifacts(args.book_dir)
        modules = (modules_for(flagged_forks(art['assessment']), art, args.issue_types)
                   or modules_for(art['assessment'], art, args.issue_types))
        print(build_prompt(art, modules, user_note=args.user_note, issue_types=args.issue_types))
        return

    if args.engine == 'aider':
        import vibe_aider  # lazy — only the aider path needs it
        rc, _ = vibe_aider.run_aider_loop(args.book_dir, args.max_attempts, args.model,
                                          user_note=args.user_note, file_issue=args.github,
                                          issue_types=args.issue_types)
        sys.exit(rc)

    rc, _ = run_loop(args.book_dir, args.max_attempts, args.model,
                     mock_diff=args.mock_diff, user_note=args.user_note, file_issue=args.github,
                     issue_types=args.issue_types)
    sys.exit(rc)


if __name__ == '__main__':
    main()
