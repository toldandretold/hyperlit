#!/usr/bin/env python3
"""Alternative-OCR engine adapters — fetch per-page OCR from open-weights VLMs
(hosted on DeepInfra, or served locally by llama.cpp/Ollama/LM Studio) and
assemble the result into the pipeline's Mistral-shaped ocr_response.json.

This is the Python port of macOShyperlit/hyperlit/PdfOcr/VlmOcrClient.swift:
each PDF page is rasterised to a JPEG and sent to an OpenAI-compatible
/chat/completions endpoint with a transcription prompt; per-engine parsers
normalise model quirks (olmOCR YAML front matter, DeepSeek grounding tokens).

Library only — the CLI lives in ocr_engine_compare.py.

Resumability: every transcribed page is cached at
    engine-cache/<fixture>/<engine>/pages/page_NNNN.md (+ .meta.json)
so a run killed halfway (e.g. a local llama-server dying on a 16GB Mac)
resumes exactly where it stopped. Only missing pages are ever fetched.

Running dots.ocr locally on a 16GB Mac (the conservative recipe):

    llama-server -hf ggml-org/dots.ocr-GGUF:Q4_K_M \\
      --port 8080 -c 8192 -np 1 -b 512 -ub 256 --jinja

  Q4_K_M is ~2GB of weights (+ mmproj, auto-downloaded); the capped context,
  single slot, and small batches keep the whole server around 4-5GB. Close
  browsers/heavy apps first. Flag names drift between llama.cpp versions —
  treat this line as a starting point. If the server dies mid-run, restart it
  and re-run the harness: already-transcribed pages are cached.

Round-2 note (dots.ocr): this harness prompts every engine for markdown with
the shared GENERIC_PROMPT so engines differ only by model. dots.ocr's NATIVE
mode emits layout-JSON with first-class Page-header/Page-footer/Footnote
categories — a future parser="dots-layout" could map those directly onto the
response's header/footer fields (the only engine that could populate them the
way Mistral's extract_header does).

Deps (harness-only, not in requirements.txt — same precedent as mistralai/pypdf):
    python3 -m pip install pymupdf httpx
"""
import base64
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path

LLAMA_SERVER_HINT = (
    "llama-server -hf ggml-org/dots.ocr-GGUF:Q4_K_M "
    "--port 8080 -c 8192 -np 1 -b 512 -ub 256 --jinja"
)


def require_fitz():
    try:
        import fitz  # noqa: F401  (PyMuPDF)
        return fitz
    except ImportError:
        sys.exit("PyMuPDF is required for page rasterisation: python3 -m pip install pymupdf")


def require_httpx():
    try:
        import httpx  # noqa: F401
        return httpx
    except ImportError:
        sys.exit("httpx is required for engine HTTP calls: python3 -m pip install httpx")


# ------------------------------------------------------------------- prompts

# Port of VlmOcrClient.swift pagePrompt — keep in sync. Prescribes the [^N]
# footnote dialect the pipeline's pdf_shared.py recognises.
GENERIC_PROMPT = """Transcribe this scanned page to Markdown. Rules:
- Output ONLY the page's content as Markdown. No commentary, no code fences.
- Use #/##/### only for real section or chapter headings. Page numbers, \
running headers/footers, and table-of-contents lines are NEVER headings — \
omit running headers, footers, and bare page numbers entirely.
- Footnote references in the text: write them as [^N] immediately after the \
word they follow. Footnote definitions (usually smaller print at the bottom \
of the page): write each on its own line as [^N]: followed by its text.
- Join words hyphenated across line breaks. Write each paragraph as one \
block; separate paragraphs with a blank line.
- Transcribe tables as Markdown tables.
- For charts, figures, or photos, write one short italic line describing \
the figure instead of transcribing its axis labels.
- If the page is blank, output nothing."""

# olmOCR-2's own finetuning prompt (build_no_anchoring_v4_yaml_prompt, verbatim
# from allenai/olmocr olmocr/prompts/prompts.py) — the model was trained on this
# exact wording; the generic prompt underperforms with it.
OLMOCR_PROMPT = (
    "Attached is one page of a document that you must process. "
    "Just return the plain text representation of this document as if you were reading it naturally. "
    "Convert equations to LateX and tables to HTML.\n"
    "If there are any figures or charts, label them with the following markdown syntax "
    "![Alt text describing the contents of the figure](page_startx_starty_width_height.png)\n"
    "Return your output as markdown, with a front matter section on top specifying values for the "
    "primary_language, is_rotation_valid, rotation_correction, is_table, and is_diagram parameters."
)

# DeepSeek-OCR canonical layout-aware prompt. The no-layout alternative is
# simply "Free OCR." (no stripping needed, but weaker structure).
DEEPSEEK_PROMPT = "<|grounding|>Convert the document to markdown."


# ------------------------------------------------------------------- parsers

def _strip_fences(text):
    """Port of VlmOcrClient.cleaned() — models love ``` fences despite orders."""
    t = (text or "").strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
        if t.endswith("```"):
            t = t[:-3]
    return t.strip()


def parse_generic(text):
    return _strip_fences(text)


def parse_olmocr(text):
    """Strip olmOCR's YAML front matter (or the older JSON-object form)."""
    t = _strip_fences(text)
    if t.startswith("---"):
        end = t.find("\n---", 3)
        if end != -1:
            after = t.find("\n", end + 1)
            t = t[after + 1:] if after != -1 else ""
    elif t.startswith("{") and t.endswith("}"):
        try:
            t = json.loads(t).get("natural_text") or ""
        except (ValueError, AttributeError):
            pass
    t = t.strip()
    return "" if t.lower() == "null" else t


_DEEPSEEK_REF_DET = re.compile(r"<\|ref\|>.*?<\|/ref\|>\s*<\|det\|>.*?<\|/det\|>", re.S)
_DEEPSEEK_DET = re.compile(r"<\|det\|>.*?<\|/det\|>", re.S)
_DEEPSEEK_REF = re.compile(r"<\|ref\|>(.*?)<\|/ref\|>", re.S)
_DEEPSEEK_TOKEN = re.compile(r"<\|[A-Za-z_/]+\|>")


def parse_deepseek(text):
    """Strip DeepSeek-OCR grounding artefacts: label+bbox pairs are removed
    wholesale (the content text follows them), stray refs are unwrapped, and
    residual <|...|> tokens deleted."""
    t = _strip_fences(text)
    t = _DEEPSEEK_REF_DET.sub("", t)
    t = _DEEPSEEK_DET.sub("", t)
    t = _DEEPSEEK_REF.sub(r"\1", t)
    t = _DEEPSEEK_TOKEN.sub("", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


PARSERS = {"generic": parse_generic, "olmocr": parse_olmocr, "deepseek": parse_deepseek}


# -------------------------------------------------------------------- engines

@dataclass(frozen=True)
class EngineSpec:
    name: str                  # cache key + report label
    base_url: str              # OpenAI-compatible base, WITHOUT /chat/completions
    model: str
    api_key_env: str | None    # None => no Authorization header (local server)
    prompt: str
    parser: str                # key into PARSERS
    price_in_per_mtok: float   # 0.0 for local
    price_out_per_mtok: float
    max_long_side_px: int = 1288
    concurrency: int = 4
    is_local: bool = False
    max_tokens: int = 4096
    # Per-request HTTP timeout. Hosted APIs answer a page in 1-5s — a request
    # still open after 3 minutes is a hung/degenerate generation (VLM repetition
    # loop on a graphics-heavy page), and waiting 600s x 3 retries for each one
    # is how a corpus run silently eats hours. Local servers legitimately take
    # minutes per page, so they keep the long leash.
    request_timeout: int = 120


PRESETS = {
    "deepinfra-olmocr2": EngineSpec(
        name="deepinfra-olmocr2",
        base_url="https://api.deepinfra.com/v1/openai",
        model="allenai/olmOCR-2-7B-1025",
        api_key_env="DEEPINFRA_API_KEY",
        prompt=OLMOCR_PROMPT,
        parser="olmocr",
        price_in_per_mtok=0.09,
        price_out_per_mtok=0.19,
    ),
    "deepinfra-deepseek-ocr": EngineSpec(
        name="deepinfra-deepseek-ocr",
        base_url="https://api.deepinfra.com/v1/openai",
        model="deepseek-ai/DeepSeek-OCR",
        api_key_env="DEEPINFRA_API_KEY",
        prompt=DEEPSEEK_PROMPT,
        parser="deepseek",
        price_in_per_mtok=0.03,
        price_out_per_mtok=0.10,
    ),
    # PaddleOCR-VL is natively an ELEMENT-level recogniser (task prompts "OCR:",
    # "Table Recognition:", ...) driven by a separate layout model; whole-page
    # chat is off-label. Included as a cheap floor, not a favourite.
    "deepinfra-paddleocr": EngineSpec(
        name="deepinfra-paddleocr",
        base_url="https://api.deepinfra.com/v1/openai",
        model="PaddlePaddle/PaddleOCR-VL-0.9B",
        api_key_env="DEEPINFRA_API_KEY",
        prompt=GENERIC_PROMPT,
        parser="generic",
        price_in_per_mtok=0.14,
        price_out_per_mtok=0.80,
    ),
    "local-dots": EngineSpec(
        name="local-dots",
        base_url="http://localhost:8080/v1",
        model="dots.ocr",   # llama-server serves one model; the name is cosmetic
        api_key_env=None,
        prompt=GENERIC_PROMPT,
        parser="generic",
        price_in_per_mtok=0.0,
        price_out_per_mtok=0.0,
        concurrency=1,
        is_local=True,
        request_timeout=600,
    ),
}


def _safe_name(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")


def resolve_engine(spec_str, base_url=None, model=None, key_env=None, engine_name=None):
    """Resolve an --engines entry: a preset name, `vlm:<base_url>:<model>`, or
    `generic` (fields supplied via flags). Flag values override in all forms."""
    if spec_str in PRESETS:
        spec = PRESETS[spec_str]
    elif spec_str.startswith("vlm:"):
        rest = spec_str[4:]
        if ":" not in rest:
            sys.exit(f"Bad engine spec {spec_str!r} — expected vlm:<base_url>:<model>")
        b, m = rest.rsplit(":", 1)
        local = "localhost" in b or "127.0.0.1" in b
        spec = EngineSpec(
            name=_safe_name(f"vlm-{m}"), base_url=b, model=m, api_key_env=None,
            prompt=GENERIC_PROMPT, parser="generic",
            price_in_per_mtok=0.0, price_out_per_mtok=0.0,
            concurrency=1 if local else 4, is_local=local,
            request_timeout=600 if local else 180,
        )
    elif spec_str == "generic":
        if not (base_url and model):
            sys.exit("Engine 'generic' needs --base-url and --model")
        spec = EngineSpec(
            name=_safe_name(engine_name or f"generic-{model}"), base_url=base_url,
            model=model, api_key_env=key_env, prompt=GENERIC_PROMPT, parser="generic",
            price_in_per_mtok=0.0, price_out_per_mtok=0.0,
            concurrency=1 if ("localhost" in base_url or "127.0.0.1" in base_url) else 4,
            is_local="localhost" in base_url or "127.0.0.1" in base_url,
            request_timeout=600 if ("localhost" in base_url or "127.0.0.1" in base_url) else 180,
        )
    else:
        sys.exit(f"Unknown engine {spec_str!r}. Presets: {', '.join(PRESETS)}; "
                 f"or vlm:<base_url>:<model>; or generic with --base-url/--model.")
    overrides = {}
    if base_url and spec_str != "generic":
        overrides["base_url"] = base_url
    if model and spec_str != "generic":
        overrides["model"] = model
    if key_env and spec_str != "generic":
        overrides["api_key_env"] = key_env
    if engine_name:
        overrides["name"] = _safe_name(engine_name)
    return replace(spec, **overrides) if overrides else spec


class LocalServerDown(RuntimeError):
    """Raised when a local engine's server is unreachable — aborts the run
    cleanly; already-fetched pages stay cached, so the run is resumable."""


def preflight_local(spec):
    httpx = require_httpx()
    base = spec.base_url.rstrip("/")
    try:
        httpx.get(base + "/models", timeout=5)
    except Exception as e:  # noqa: BLE001
        raise LocalServerDown(
            f"Cannot reach local engine {spec.name} at {spec.base_url} ({type(e).__name__}: {e}).\n"
            f"Is the server running? e.g.:\n  {LLAMA_SERVER_HINT}"
        ) from e


# ---------------------------------------------------------------------- fetch

def rasterize_page(fitz, doc, index, max_long_side):
    page = doc[index]
    rect = page.rect
    zoom = max_long_side / max(rect.width, rect.height)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    try:
        return pix.tobytes("jpeg", jpg_quality=80)
    except TypeError:  # older PyMuPDF without the quality kwarg
        return pix.tobytes("jpeg")


def transcribe_page(jpeg_bytes, spec, api_key):
    """One page → (markdown, usage). Port of VlmOcrClient.transcribe."""
    httpx = require_httpx()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = {
        "model": spec.model,
        "temperature": 0,
        "max_tokens": spec.max_tokens,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": spec.prompt},
                {"type": "image_url", "image_url": {
                    "url": "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode(),
                }},
            ],
        }],
    }
    r = httpx.post(spec.base_url.rstrip("/") + "/chat/completions",
                   headers=headers, json=body, timeout=spec.request_timeout)
    r.raise_for_status()
    data = r.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError(f"no choices[0].message.content in response: {str(data)[:200]}")
    usage = data.get("usage") or {}
    return PARSERS[spec.parser](content), {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
    }


def _fetch_one_page(fitz, doc, index, spec, api_key, pages_dir):
    """Fetch page `index` with retries, writing the page cache on success.
    Returns True on success. Local ConnectError aborts via LocalServerDown."""
    import httpx
    jpeg = rasterize_page(fitz, doc, index, spec.max_long_side_px)
    last_err = None
    for attempt, delay in enumerate((0, 2, 8)):
        if delay:
            time.sleep(delay)
        t0 = time.monotonic()
        try:
            md, usage = transcribe_page(jpeg, spec, api_key)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            if spec.is_local:
                raise LocalServerDown(
                    f"page {index}: lost the local server at {spec.base_url} — restart it and "
                    f"re-run (this run is resumable; finished pages are cached).\n  {LLAMA_SERVER_HINT}"
                ) from e
            last_err = e
            continue
        except httpx.TimeoutException as e:
            # A hosted request that blows the timeout is a degenerate generation
            # (VLM repetition loop on a messy scan page) — at temperature 0 a
            # retry hangs identically, so fail fast and record the page.
            last_err = e
            break
        except Exception as e:  # noqa: BLE001 — HTTP 5xx, parse errors
            last_err = e
            continue
        meta = {**usage, "elapsed": round(time.monotonic() - t0, 2)}
        (pages_dir / f"page_{index:04d}.md").write_text(md, encoding="utf-8")
        (pages_dir / f"page_{index:04d}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
        return True
    print(f"    ! page {index} failed after retries: {type(last_err).__name__}: {last_err}",
          file=sys.stderr)
    return False


def fetch_engine_ocr(pdf_path, spec, cache_dir, api_key=None, refresh=False):
    """Fetch (or load cached) a Mistral-shaped OCR response for one engine.

    Returns (response_dict, elapsed_or_None, usage_totals, failed_pages).
    The page-level cache under <cache_dir>/pages/ is the real cache: only
    missing pages are fetched, then the response is (re)assembled for exactly
    the pages of `pdf_path`. The assembled file reflects the latest run scope.
    """
    fitz = require_fitz()
    cache_dir = Path(cache_dir)
    final_path = cache_dir / f"ocr_response.{spec.name}.json"
    pages_dir = cache_dir / "pages"

    doc = fitz.open(str(pdf_path))
    n_pages = doc.page_count

    if final_path.exists() and not refresh:
        cached = json.loads(final_path.read_text(encoding="utf-8"))
        info = cached.get("usage_info", {})
        if len(cached.get("pages", [])) == n_pages and not info.get("failed_pages"):
            doc.close()
            print(f"    cache hit: {final_path.name}")
            usage = {"prompt_tokens": info.get("prompt_tokens", 0),
                     "completion_tokens": info.get("completion_tokens", 0)}
            return cached, None, usage, []

    if refresh and pages_dir.exists():
        for f in pages_dir.iterdir():
            f.unlink()
    pages_dir.mkdir(parents=True, exist_ok=True)

    missing = [i for i in range(n_pages) if not (pages_dir / f"page_{i:04d}.md").exists()]
    elapsed = None
    if missing:
        if spec.is_local:
            preflight_local(spec)
        print(f"    fetching {len(missing)}/{n_pages} page(s) via {spec.name}"
              f" ({'sequential' if spec.concurrency == 1 else f'{spec.concurrency} workers'})...")
        t0 = time.monotonic()
        if spec.concurrency == 1:
            for i in missing:
                _fetch_one_page(fitz, doc, i, spec, api_key, pages_dir)
        else:
            with ThreadPoolExecutor(max_workers=spec.concurrency) as pool:
                list(pool.map(lambda i: _fetch_one_page(fitz, doc, i, spec, api_key, pages_dir), missing))
        elapsed = time.monotonic() - t0
        print(f"    done in {elapsed:.1f}s")

    # Assemble from the page cache (Mistral-shaped, same as VlmOcrClient.swift).
    pages, failed = [], []
    usage_totals = {"prompt_tokens": 0, "completion_tokens": 0}
    for i in range(n_pages):
        md_file = pages_dir / f"page_{i:04d}.md"
        meta_file = pages_dir / f"page_{i:04d}.meta.json"
        md = md_file.read_text(encoding="utf-8") if md_file.exists() else ""
        if not md_file.exists():
            failed.append(i)
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                usage_totals["prompt_tokens"] += meta.get("prompt_tokens", 0)
                usage_totals["completion_tokens"] += meta.get("completion_tokens", 0)
            except ValueError:
                pass
        rect = doc[i].rect
        pages.append({
            "index": i,
            "markdown": md,
            "images": [],
            "dimensions": {"dpi": 72, "height": int(rect.height), "width": int(rect.width)},
            "tables": [],
            "hyperlinks": [],
            "header": "",
            "footer": "",
        })
    doc.close()

    response = {
        "pages": pages,
        # hyperlit- prefix = never billed, should this file ever reach an import dir.
        "model": f"hyperlit-eval-{spec.name}",
        "usage_info": {
            "pages_processed": n_pages,
            "engine": spec.name,
            "endpoint_model": spec.model,
            "failed_pages": failed,
            **usage_totals,
        },
        "document_annotation": None,
    }
    cache_dir.mkdir(parents=True, exist_ok=True)
    final_path.write_text(json.dumps(response), encoding="utf-8")
    if failed:
        print(f"    ! {len(failed)} page(s) failed and are empty in the response: {failed}",
              file=sys.stderr)
    return response, elapsed, usage_totals, failed


def actual_cost_usd(spec, usage_totals):
    return round(
        usage_totals.get("prompt_tokens", 0) / 1e6 * spec.price_in_per_mtok
        + usage_totals.get("completion_tokens", 0) / 1e6 * spec.price_out_per_mtok, 4)
