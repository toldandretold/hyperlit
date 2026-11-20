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


_OLMOCR_FM_KEY = re.compile(
    r"^(primary_language|is_rotation_valid|rotation_correction|is_table|is_diagram)\s*:")


def _strip_olmocr_fenced_front_matter(t):
    """olmOCR-2 on DeepInfra wraps its front matter in a ```yaml fence and puts
    the page text AFTER the closing fence. `_strip_fences` drops only the opening
    line (the text doesn't END with ```), leaving the bare YAML keys plus a stray
    closing fence glued onto every page — the 109 "stray code-fence" lines the
    2026-08-20 full run stripped. Idempotent, so it also cleans cached pages that
    were saved through the old parser."""
    lines = t.split("\n")
    i = 0
    if i < len(lines) and lines[i].strip() == "---":
        i += 1
    j = i
    while j < len(lines) and _OLMOCR_FM_KEY.match(lines[j].strip()):
        j += 1
    if j == i:
        return t
    while j < len(lines) and lines[j].strip() in ("---", "```", ""):
        j += 1
    return "\n".join(lines[j:])


def parse_olmocr(text):
    """Strip olmOCR's YAML front matter (or the older JSON-object form)."""
    t = _strip_fences(text)
    t = _strip_olmocr_fenced_front_matter(t)
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


# ------------------------------------------------------------------ dots.ocr
#
# dots.ocr / dots.mocr answer prompt_layout_all_en with a JSON LIST of cells
# {"bbox": [x1,y1,x2,y2], "category": ..., "text": ...} in reading order, with
# categories Caption / Footnote / Formula / List-item / Page-footer /
# Page-header / Picture / Section-header / Table / Text / Title (Formula text
# is LaTeX, Table text is HTML, the rest Markdown). That is the closest any
# open engine comes to Mistral's own shape, so instead of flattening it to
# prose we MAP it: Page-header/Page-footer → the page's header/footer fields
# (assembly.py's footer rescue reads `footer`), Footnote cells → `[^N]:`
# definition lines, Section-header/Title → markdown headings.
#
# The page cache stores the RAW model response for this parser (EngineSpec.
# raw_page_cache) and parsing happens at assembly, so improving this mapping
# never needs a re-fetch from a paid GPU.

_DOTS_LEADING_NUM = re.compile(
    r"^\s*(?:\[\^?(\d{1,4})\]:?|\$\^\{?(\d{1,4})\}?\$|<sup>(\d{1,4})</sup>|"
    r"([¹²³⁴⁵⁶⁷⁸⁹⁰]+)|(\d{1,4})(?=[\s.)]))[\s.):]*")
_SUPERSCRIPT_DIGITS = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789")
_SUP_MARKER = re.compile(r"<sup>(\d{1,4})</sup>")


def _dots_cells(raw):
    """Decode the cell list; salvage complete cells from truncated JSON (a page
    that hit max_tokens). Returns None when the answer is not cell JSON."""
    t = _strip_fences(raw)
    try:
        cells = json.loads(t)
        if isinstance(cells, dict):
            cells = cells.get("cells") or cells.get("layout") or [cells]
        return [c for c in cells if isinstance(c, dict)] if isinstance(cells, list) else None
    except ValueError:
        pass
    if not t.lstrip().startswith(("[", "{")):
        return None
    dec, cells, i = json.JSONDecoder(), [], 0
    while True:
        i = t.find("{", i)
        if i == -1:
            break
        try:
            obj, end = dec.raw_decode(t, i)
        except ValueError:
            i += 1
            continue
        if isinstance(obj, dict) and "category" in obj:
            cells.append(obj)
        i = end
    return cells


def _dots_footnote_lines(text):
    """'1 Smith, A. (2010)…\\n2 Ibid.' → ['[^1]: Smith…', '[^2]: Ibid.'].
    Lines without a leading number continue the previous definition; a cell
    with no number at all is returned unchanged (the pipeline's own def
    recovery still gets a go at it)."""
    out = []
    for line in (text or "").split("\n"):
        line = line.strip()
        if not line:
            continue
        m = _DOTS_LEADING_NUM.match(line)
        num = next((g for g in m.groups() if g), None) if m else None
        if num:
            num = num.translate(_SUPERSCRIPT_DIGITS)
            out.append(f"[^{int(num)}]: {line[m.end():].strip()}")
        elif out and out[-1].startswith("[^"):
            out[-1] += " " + line
        else:
            out.append(line)
    return out


def parse_dots_page(raw):
    """Raw dots answer → {"markdown", "header", "footer"} (Mistral page shape)."""
    cells = _dots_cells(raw)
    if cells is None:  # prose answer (e.g. prompt_ocr) — treat as plain markdown
        return {"markdown": _strip_fences(raw), "header": "", "footer": ""}
    body, header, footer = [], [], []
    for c in cells:
        cat = c.get("category", "Text")
        text = (c.get("text") or "").strip()
        if cat == "Picture" or not text:
            continue  # images are not extracted in the eval (images: [])
        if cat == "Page-header":
            header.append(text)
        elif cat == "Page-footer":
            footer.append(text)
        elif cat == "Footnote":
            body.extend(_dots_footnote_lines(text))
        elif cat in ("Title", "Section-header"):
            body.append(text if text.startswith("#") else ("# " if cat == "Title" else "## ") + text)
        elif cat == "Formula":
            body.append(text if text.startswith("$$") else f"$$\n{text.strip('$').strip()}\n$$")
        elif cat == "Table":
            # simple_md_to_html passes block HTML through only as `<table ` (with
            # attributes); a bare `<table>` would be escaped as a paragraph.
            body.append(re.sub(r"^<table>", '<table class="ocr-table">', text))
        else:
            body.append(_SUP_MARKER.sub(r"[^\1]", text))
    return {"markdown": "\n\n".join(body), "header": "\n".join(header),
            "footer": "\n".join(footer)}


def parse_dots(raw):
    return parse_dots_page(raw)["markdown"]


# dots' own prompt_layout_all_en, verbatim from rednote-hilab/dots.ocr
# dots_ocr/utils/prompts.py. The <|img|><|imgpad|><|endofimg|> prefix is what
# their inference_with_vllm sends (without it vLLM v1 inserts a "\n"), and the
# image goes FIRST in the content list.
DOTS_PROMPT = "<|img|><|imgpad|><|endofimg|>" + """Please output the layout information from the PDF image, including each layout element's bbox, its category, and the corresponding text content within the bbox.

1. Bbox format: [x1, y1, x2, y2]

2. Layout Categories: The possible categories are ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'].

3. Text Extraction & Formatting Rules:
    - Picture: For the 'Picture' category, the text field should be omitted.
    - Formula: Format its text as LaTeX.
    - Table: Format its text as HTML.
    - All Others (Text, Title, etc.): Format their text as Markdown.

4. Constraints:
    - The output text must be the original text from the image, with no translation.
    - All layout elements must be sorted according to human reading order.

5. Final Output: The entire output must be a single JSON object.
"""


PARSERS = {"generic": parse_generic, "olmocr": parse_olmocr, "deepseek": parse_deepseek,
           "dots": parse_dots}


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
    temperature: float = 0.0
    top_p: float | None = None
    image_first: bool = False      # put the image before the prompt text (dots)
    raw_page_cache: bool = False   # cache the raw answer; parse at assembly


# Rented GPU running vLLM (see pod_ocr_eval.sh). base_url is a placeholder —
# the wrapper passes the pod's URL with --base-url. Settings follow dots' own
# parser: 200-dpi-ish render (≈2200px long side), temperature 0.1 / top_p 0.9,
# and a generous output budget — bbox JSON is verbose, and the 4096 cap the
# DeepInfra presets use truncated ~1% of pages on every engine (2026-11-19).
_POD_DOTS = dict(
    base_url="http://localhost:8000/v1",
    model="model",          # vllm serve ... --served-model-name model
    api_key_env="OCR_POD_KEY",
    prompt=DOTS_PROMPT,
    parser="dots",
    price_in_per_mtok=0.0,  # billed by the hour; cost/page = $/hr ÷ pages/hr
    price_out_per_mtok=0.0,
    max_long_side_px=2200,
    concurrency=8,          # vLLM batches concurrent requests on one GPU
    max_tokens=16384,
    request_timeout=600,
    temperature=0.1,
    top_p=0.9,
    image_first=True,
    raw_page_cache=True,
)


PRESETS = {
    "pod-dots": EngineSpec(name="pod-dots", **_POD_DOTS),
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
    text_part = {"type": "text", "text": spec.prompt}
    image_part = {"type": "image_url", "image_url": {
        "url": "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode(),
    }}
    body = {
        "model": spec.model,
        "temperature": spec.temperature,
        "max_tokens": spec.max_tokens,
        "messages": [{
            "role": "user",
            "content": [image_part, text_part] if spec.image_first else [text_part, image_part],
        }],
    }
    if spec.top_p is not None:
        body["top_p"] = spec.top_p
    r = httpx.post(spec.base_url.rstrip("/") + "/chat/completions",
                   headers=headers, json=body, timeout=spec.request_timeout)
    r.raise_for_status()
    data = r.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError(f"no choices[0].message.content in response: {str(data)[:200]}")
    usage = data.get("usage") or {}
    return (content if spec.raw_page_cache else PARSERS[spec.parser](content)), {
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
        header = footer = ""
        if md and spec.parser == "olmocr":
            # Re-clean pages cached through an older parser (parse is idempotent).
            md = parse_olmocr(md)
        elif md and spec.parser == "dots":
            parsed = parse_dots_page(md)  # cache holds the raw cell JSON
            md, header, footer = parsed["markdown"], parsed["header"], parsed["footer"]
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
            "header": header,
            "footer": footer,
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
