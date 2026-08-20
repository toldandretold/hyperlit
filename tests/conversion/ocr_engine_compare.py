#!/usr/bin/env python3
"""Multi-engine OCR comparison harness — run PDF fixtures through alternative
open-weights OCR engines (DeepInfra-hosted olmOCR-2 / DeepSeek-OCR /
PaddleOCR-VL, a local dots.ocr server, or any OpenAI-compatible endpoint),
score each with the SAME pipeline + metrics production uses, and optionally
replay each engine's output through the real regression suite
(run_regression.py --ocr-variant) to compare against manifest expectations.

The sibling of ocr_version_compare.py (Mistral-version comparison): this tool
imports its scoring (run_pipeline / metrics_row / slice_pdf) so metric rows are
computed identically, but fetches per-page via chat/completions with resumable
page caching (see vlm_ocr_engines.py).

Outputs land in the git-ignored tests/conversion/engine-cache/:
    engine-cache/<fixture-leaf>/<engine>/pages/page_NNNN.md   resumable page cache
    engine-cache/<fixture-leaf>/<engine>/ocr_response.<engine>.json
    engine-cache/ENGINES_REPORT.md + report.json
    engine-cache/baseline.regression.json

NOTE on --regression: manifest expected{} counts describe the FULL document, so
regression checks only run for fixtures OCR'd whole (--full, or docs shorter
than --max-pages). Page-capped runs still get the metrics comparison.

Usage:
  python3 tests/conversion/ocr_engine_compare.py --list
  python3 tests/conversion/ocr_engine_compare.py --seed-mistral --fixtures native-engine
  DEEPINFRA_API_KEY=... python3 tests/conversion/ocr_engine_compare.py \\
      --engines deepinfra-olmocr2,deepinfra-deepseek-ocr,deepinfra-paddleocr \\
      --fixtures native-engine --full --yes --regression
  python3 tests/conversion/ocr_engine_compare.py --engines local-dots \\
      --fixtures native-engine --max-pages 5
  python3 tests/conversion/ocr_engine_compare.py \\
      --engines "vlm:http://localhost:1234/v1:qwen2.5-vl-7b" --fixtures native-engine
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import ocr_version_compare as ovc  # noqa: E402 — also wires app/Python onto sys.path
import run_regression as rr  # noqa: E402
import vlm_ocr_engines as eng  # noqa: E402
from pypdf import PdfReader  # noqa: E402

ENGINE_CACHE = SCRIPT_DIR / "engine-cache"
RUN_REGRESSION = SCRIPT_DIR / "run_regression.py"
# Rough per-page token heuristic for the cost preview (1288px page image + prose).
EST_PROMPT_TOK_PER_PAGE = 1400
EST_COMPLETION_TOK_PER_PAGE = 800


# ------------------------------------------------------------------- corpus

def resolve_fixture_pdf(fx):
    """The two-source lookup (grobid_trial.py pattern): in-fixture PDF first,
    then the book's original upload under resources/markdown/."""
    for name in ("source.pdf", "original.pdf"):
        p = os.path.join(fx["dir"], name)
        if os.path.isfile(p):
            return Path(p)
    book_id = fx["manifest"].get("book_id")
    if book_id:
        p = os.path.join(rr.PROJECT_ROOT, "resources", "markdown", str(book_id), "original.pdf")
        if os.path.isfile(p):
            return Path(p)
    return None


def pdf_fixtures(filters=None):
    """PDF-pipeline fixtures with their resolved source PDF (or None)."""
    out = []
    for fx in rr.discover_fixtures():
        if fx["pipeline"] != "pdf":
            continue
        if filters and not any(f in fx["name"] for f in filters):
            continue
        fx["key"] = rr.variant_cache_key(fx)       # engine-cache dir key (path-unique)
        fx["plain_name"] = fx["name"].replace(" [local]", "")  # for --fixture selection
        fx["pdf"] = resolve_fixture_pdf(fx)
        out.append(fx)
    return out


def page_count(pdf_path):
    try:
        return len(PdfReader(str(pdf_path)).pages)
    except Exception:  # noqa: BLE001
        return None


def cmd_list():
    fixtures = pdf_fixtures()
    with_pdf = [(fx, page_count(fx["pdf"])) for fx in fixtures if fx["pdf"]]
    with_pdf.sort(key=lambda t: (t[1] is None, t[1]))
    print(f"\nEngine-comparable PDF fixtures ({len(with_pdf)}/{len(fixtures)} have a source PDF):\n")
    for fx, n in with_pdf:
        exp = fx["manifest"].get("expected", {})
        print(f"  {n if n is not None else '?':>4}p  {fx['name']}"
              f"  (expected keys: {', '.join(sorted(exp)) or 'none'})")
    missing = [fx for fx in fixtures if not fx["pdf"]]
    if missing:
        print(f"\nNo PDF found for {len(missing)} fixture(s) (metrics/regression vs Mistral "
              f"cache only, not re-OCR-able):")
        for fx in missing:
            print(f"        {fx['name']}")
    print("\nShort fixtures are the cheap --full candidates for --regression runs.")


# --------------------------------------------------------------- seed-mistral

def seed_mistral(fixtures):
    """Copy each fixture's committed Mistral response into engine-cache under the
    engine name 'mistral-baseline', for the run_regression --ocr-variant identity
    proof (variant replay must match the normal replay on every non-golden check)."""
    for fx in fixtures:
        src = os.path.join(fx["dir"], "ocr_response.json")
        dst_dir = ENGINE_CACHE / fx["key"] / "mistral-baseline"
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / "ocr_response.mistral-baseline.json"
        shutil.copy2(src, dst)
        print(f"  seeded {fx['key']} -> {dst.relative_to(SCRIPT_DIR)}")
    print("\nNow verify: python3 tests/conversion/run_regression.py "
          "--ocr-variant mistral-baseline --fixture <name>")


# ----------------------------------------------------------------- regression

def run_regression_json(fixture_name, variant=None):
    """Run run_regression.py --json for one fixture (optionally --ocr-variant)
    and return that fixture's result entry, or None on harness failure."""
    cmd = [sys.executable, str(RUN_REGRESSION), "--json", "--fixture", fixture_name]
    if variant:
        cmd += ["--ocr-variant", variant]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    try:
        data = json.loads(r.stdout)
    except ValueError:
        print(f"    ! run_regression --json produced no JSON for {fixture_name}"
              f" (exit {r.returncode}): {(r.stderr or '')[-200:]}", file=sys.stderr)
        return None
    for entry in data.get("fixtures", []):
        if fixture_name in entry.get("name", ""):
            return entry
    return None


def regression_delta(baseline, variant):
    """Compare check outcomes between the baseline Mistral run and a variant run."""
    if variant is None:
        return {"status": "error", "summary": "regression run produced no result"}
    if variant.get("status") == "skip":
        return {"status": "skip",
                "summary": (variant.get("checks") or [{}])[0].get("message", "skipped")}
    base_checks = {c["name"]: c for c in (baseline or {}).get("checks", [])}
    newly_failing, newly_passing, same = [], [], 0
    for c in variant.get("checks", []):
        b = base_checks.get(c["name"])
        if c["passed"] and (b is None or b["passed"]):
            same += 1
        elif c["passed"] and b and not b["passed"]:
            newly_passing.append(c["name"])
        elif not c["passed"]:
            label = f"{c['name']} ({c['message'][:120]})"
            if b is None or b["passed"]:
                newly_failing.append(label)
            else:
                newly_failing.append(label + " [also fails on mistral]")
    return {
        "status": variant.get("status"),
        "same_pass": same,
        "newly_failing": newly_failing,
        "newly_passing": newly_passing,
        "summary": f"{variant.get('status')}: {same} check(s) pass"
                   + (f", failing: {len(newly_failing)}" if newly_failing else "")
                   + (f", newly passing vs mistral: {len(newly_passing)}" if newly_passing else ""),
    }


# --------------------------------------------------------------------- report

def write_report(all_results, out_dir, max_pages):
    md = ["# OCR engine comparison\n"]
    cap = "full documents" if max_pages is None else f"first {max_pages} pages per PDF"
    md.append(f"Scope: **{cap}**. Costs are computed from actual API `usage` tokens; "
              f"the `mistral (fixture)` reference row always reflects the FULL committed "
              f"response, regardless of page cap.\n")

    for fixture_leaf, block in all_results.items():
        md.append(f"## {block['fixture_name']} ({block['pages']}p"
                  + (", full" if block["full_doc"] else ", capped") + ")\n")
        if block.get("mistral_row"):
            md.append(ovc.fmt_row(block["mistral_row"]))
            md.append("")
        for engine_name, res in block["engines"].items():
            md.append(f"### {engine_name}\n")
            md.append(ovc.fmt_row(res["row"]))
            extra = (f"    - sec/page: {res.get('sec_per_page')}"
                     f" · failed pages: {len(res.get('failed_pages') or [])}")
            md.append(extra)
            reg = res.get("regression")
            if reg:
                md.append(f"    - regression: {reg['summary']}")
                for f in reg.get("newly_failing", []):
                    md.append(f"      - FAIL {f}")
                for f in reg.get("newly_passing", []):
                    md.append(f"      - newly passing: {f}")
            elif not block["full_doc"]:
                md.append("    - regression: not run (page-capped OCR vs full-document expectations)")
            md.append("")
        classes = {r["row"].get("classification") for r in block["engines"].values()
                   if not r["row"].get("error")}
        if block.get("mistral_row") and not block["mistral_row"].get("error"):
            classes.add(block["mistral_row"].get("classification"))
        if len(classes) > 1:
            md.append(f"- ⚠️ engines DISAGREE on footnote layout: {sorted(c for c in classes if c)}\n")

    # ---- ranking
    agg = {}
    for block in all_results.values():
        for engine_name, res in block["engines"].items():
            a = agg.setdefault(engine_name, {"cov": [], "printable": [], "verdicts": {},
                                             "cost": 0.0, "spp": [], "reg_pass": 0, "reg_fail": 0})
            row = res["row"]
            if row.get("coverage_vs_refs") is not None:
                a["cov"].append(row["coverage_vs_refs"])
            if row.get("printable_ratio") is not None:
                a["printable"].append(row["printable_ratio"])
            v = row.get("fidelity_verdict")
            if v:
                a["verdicts"][v] = a["verdicts"].get(v, 0) + 1
            a["cost"] += row.get("est_cost_usd") or 0.0
            if res.get("sec_per_page") is not None:
                a["spp"].append(res["sec_per_page"])
            reg = res.get("regression")
            if reg and reg.get("status") in ("pass", "fail"):
                a["reg_pass"] += reg.get("same_pass", 0) + len(reg.get("newly_passing", []))
                a["reg_fail"] += len(reg.get("newly_failing", []))

    def _mean(xs):
        return round(sum(xs) / len(xs), 3) if xs else None

    def _sort_key(item):
        a = item[1]
        total = a["reg_pass"] + a["reg_fail"]
        reg_ratio = a["reg_pass"] / total if total else -1
        return (-reg_ratio, -(_mean(a["cov"]) or 0))

    md.append("## Ranking\n")
    md.append("Ordered by regression checks passed, then footnote coverage (defs/refs). "
              "Treat single-fixture rankings as indicative only.\n")
    for i, (engine_name, a) in enumerate(sorted(agg.items(), key=_sort_key), 1):
        total = a["reg_pass"] + a["reg_fail"]
        md.append(f"{i}. **{engine_name}**")
        if total:
            md.append(f"   - regression checks: {a['reg_pass']}/{total} passed")
        md.append(f"   - mean coverage (defs/refs): {_mean(a['cov'])}"
                  f" · fidelity verdicts: {a['verdicts'] or 'n/a'}")
        md.append(f"   - mean printable_ratio: {_mean(a['printable'])}"
                  f" · total cost: ${round(a['cost'], 4)} · mean sec/page: {_mean(a['spp'])}")
        md.append("")

    report_path = out_dir / "ENGINES_REPORT.md"
    report_path.write_text("\n".join(md), encoding="utf-8")
    (out_dir / "report.json").write_text(
        json.dumps(all_results, indent=2, default=str), encoding="utf-8")
    print(f"\nReport written: {report_path}")


# ----------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Compare alternative OCR engines on the fixture corpus.")
    ap.add_argument("--list", action="store_true", help="list engine-comparable fixtures + page counts")
    ap.add_argument("--fixtures", help="comma-separated substrings selecting fixtures")
    ap.add_argument("--engines", help=f"comma-separated engines: presets ({', '.join(eng.PRESETS)}), "
                                      f"vlm:<base_url>:<model>, or generic")
    ap.add_argument("--base-url", help="generic engine: OpenAI-compatible base URL")
    ap.add_argument("--model", help="generic engine: model id")
    ap.add_argument("--key-env", help="generic engine: env var holding the API key")
    ap.add_argument("--engine-name", help="override the engine's cache/report name")
    ap.add_argument("--max-pages", type=int, default=30, help="page cap per PDF (cost guard); default 30")
    ap.add_argument("--full", action="store_true", help="disable the page cap (needed for --regression)")
    ap.add_argument("--dry-run", action="store_true", help="cost estimate only; no API calls")
    ap.add_argument("--yes", action="store_true", help="skip the spend confirmation prompt")
    ap.add_argument("--refresh", action="store_true", help="ignore cached pages/responses and re-fetch")
    ap.add_argument("--regression", action="store_true",
                    help="also replay each engine's output through run_regression.py --ocr-variant")
    ap.add_argument("--seed-mistral", action="store_true",
                    help="copy fixtures' committed Mistral responses into engine-cache as "
                         "'mistral-baseline' (identity proof for --ocr-variant)")
    args = ap.parse_args()

    if args.list:
        cmd_list()
        return

    filters = [f.strip() for f in (args.fixtures or "").split(",") if f.strip()] or None
    fixtures = pdf_fixtures(filters)
    if not fixtures:
        sys.exit("No PDF fixtures matched.")

    if args.seed_mistral:
        seed_mistral(fixtures)
        if not args.engines:
            return

    if not args.engines:
        sys.exit("Nothing to do: pass --engines (or --list / --seed-mistral).")

    engines = [eng.resolve_engine(s.strip(), args.base_url, args.model, args.key_env,
                                  args.engine_name)
               for s in args.engines.split(",") if s.strip()]

    fixtures = [fx for fx in fixtures if fx["pdf"]]
    if not fixtures:
        sys.exit("None of the selected fixtures has a source PDF (see --list).")

    # ---- slice + cost preview
    max_pages = None if args.full else args.max_pages
    work_dir = ENGINE_CACHE / "_sliced"
    plan = []  # (fixture, pdf_for_ocr, n_pages, full_doc)
    est_total = 0.0
    print(f"Corpus: {len(fixtures)} fixture(s); engines: {[e.name for e in engines]}; "
          f"scope: {'full' if max_pages is None else f'first {max_pages}p'}\n")
    for fx in fixtures:
        total = page_count(fx["pdf"])
        pdf_for_ocr, n = ovc.slice_pdf(fx["pdf"], max_pages, work_dir)
        full_doc = total is not None and n == total
        plan.append((fx, pdf_for_ocr, n, full_doc))
        est = sum(n * (EST_PROMPT_TOK_PER_PAGE / 1e6 * e.price_in_per_mtok
                       + EST_COMPLETION_TOK_PER_PAGE / 1e6 * e.price_out_per_mtok)
                  for e in engines)
        est_total += est
        local_note = " (+ local engine wall-time: expect ~10-60s/page)" \
            if any(e.is_local for e in engines) else ""
        print(f"  {fx['key']}: {n}p{' (full)' if full_doc else f' of {total}'} → ~${est:.3f}{local_note}")
    print(f"\nEstimated hosted spend (excl. cache hits, from a rough tokens/page heuristic): "
          f"~${est_total:.2f}")

    if args.regression and not all(full for *_, full in plan):
        print("\nNOTE: --regression only runs for fixtures OCR'd in full "
              "(manifest expectations describe whole documents).")

    if args.dry_run:
        print("Dry run — no API calls made.")
        return

    for e in engines:
        if e.api_key_env and not os.environ.get(e.api_key_env):
            sys.exit(f"Engine {e.name} needs the {e.api_key_env} env var set.")
    if not args.yes and est_total > 0:
        if input("Proceed and incur this cost? [y/N] ").strip().lower() != "y":
            print("Aborted.")
            return

    # ---- fetch + score
    all_results = {}
    baselines = {}
    baseline_cache_path = ENGINE_CACHE / "baseline.regression.json"
    if baseline_cache_path.exists():
        baselines = json.loads(baseline_cache_path.read_text(encoding="utf-8"))

    for fx, pdf_for_ocr, n, full_doc in plan:
        print(f"\n=== {fx['key']} ({n}p) ===")
        block = {"fixture_name": fx["name"], "pages": n, "full_doc": full_doc, "engines": {}}

        # Reference row: the fixture's committed Mistral response through the same metrics.
        try:
            mistral_resp = json.loads(
                Path(fx["dir"], "ocr_response.json").read_text(encoding="utf-8"))
            block["mistral_row"] = ovc.metrics_row("mistral (fixture)", mistral_resp,
                                                   fx["pdf"], None)
        except Exception as e:  # noqa: BLE001
            block["mistral_row"] = {"model": "mistral (fixture)", "pages": 0,
                                    "fetch_seconds": None, "est_cost_usd": 0.0,
                                    "error": f"{type(e).__name__}: {e}"}

        if args.regression and full_doc and fx["key"] not in baselines:
            print("    baseline regression run (mistral)...")
            baselines[fx["key"]] = run_regression_json(fx["plain_name"])
            baseline_cache_path.parent.mkdir(parents=True, exist_ok=True)
            baseline_cache_path.write_text(json.dumps(baselines, indent=2), encoding="utf-8")

        for spec in engines:
            print(f"  -- {spec.name}")
            cache_dir = ENGINE_CACHE / fx["key"] / spec.name
            api_key = os.environ.get(spec.api_key_env) if spec.api_key_env else None
            try:
                resp, elapsed, usage, failed = eng.fetch_engine_ocr(
                    pdf_for_ocr, spec, cache_dir, api_key=api_key, refresh=args.refresh)
            except eng.LocalServerDown as e:
                print(f"\n{e}", file=sys.stderr)
                sys.exit(2)
            except Exception as e:  # noqa: BLE001
                block["engines"][spec.name] = {
                    "row": {"model": spec.name, "pages": n, "fetch_seconds": None,
                            "est_cost_usd": 0.0, "error": f"fetch: {type(e).__name__}: {e}"}}
                continue

            row = ovc.metrics_row(spec.name, resp, pdf_for_ocr, elapsed)
            row["est_cost_usd"] = eng.actual_cost_usd(spec, usage)
            res = {
                "row": row,
                "failed_pages": failed,
                "sec_per_page": round(elapsed / n, 1) if elapsed and n else None,
            }
            if args.regression and full_doc:
                print("    regression replay...")
                variant_result = run_regression_json(fx["plain_name"], variant=spec.name)
                res["regression"] = regression_delta(baselines.get(fx["key"]), variant_result)
                print(f"    {res['regression']['summary']}")
            block["engines"][spec.name] = res

        all_results[fx["key"]] = block

    ENGINE_CACHE.mkdir(parents=True, exist_ok=True)
    write_report(all_results, ENGINE_CACHE, max_pages)


if __name__ == "__main__":
    main()
