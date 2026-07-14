# Local vision-model OCR setup (Ollama)

How to run the app's PDF OCR through a **local vision-language model** instead of Apple Vision or paid Mistral. This is the `VlmOcrClient` / `--vlm` path described in `README.md` — slower (seconds per page) but far better on **scanned books**, where Apple Vision misreads superscript footnote markers and mangles messy fonts. For clean, digital PDFs you don't need any of this: the default on-device Apple Vision engine is faster and good enough, with no model to download.

## What you're actually installing

The OCR engine renders each PDF page to an image and POSTs it to an **OpenAI-compatible chat endpoint** with a transcription prompt; the model decides what's a heading, a footnote, or a page number. That endpoint is served locally by **Ollama**. So there are two pieces: Ollama (the server) and a **vision-capable** model pulled into it.

The model must be a *vision* model. The plain-text `llama3.1` LLM preset can't read page images — it will not work for OCR. The app defaults to **`qwen2.5vl`** (7B), which is the strongest of the local vision models at dense-text OCR (footnotes, small superscripts, two-column layouts). That's the one to use.

## Requirements

- Roughly **6 GB of disk** for the model (`qwen2.5vl` 7B), stored in `~/.ollama/models`.
- Roughly **6–8 GB of free RAM** while it's loaded. It fits comfortably on a 16 GB Mac. The bigger `qwen2.5vl:32b` (~21 GB) will *not* fit in 16 GB — it swaps and crawls, so don't pull it on a 16 GB machine. If 7B is too slow, `qwen2.5vl:3b` (~3.2 GB) is the fallback, at the cost of accuracy on small footnote markers.

## One-time install

```bash
brew install ollama          # the server
ollama pull qwen2.5vl        # the vision model (~6 GB, one-time)
```

## Running the Ollama server

The model download is permanent, but the **server must be running** whenever you OCR. Pick one:

- **Always on (recommended for regular testing):** `brew services start ollama` — starts it now and restarts it at login. Stop with `brew services stop ollama`.
- **Manual, when you need it:** `ollama serve` in a terminal, left running. Dies when you close it.

Confirm it's up and the model is registered:

```bash
curl -s http://localhost:11434/api/version                 # {"version":"..."}
ollama list                                                # qwen2.5vl:latest ... 6.0 GB
curl -s http://localhost:11434/v1/models                   # the OpenAI-compat endpoint the app calls
```

## Using it — in the app

1. Open Settings (⌘,) → **PDF OCR** tab.
2. Click the **"Ollama vision (local)"** preset. It fills in base URL `http://localhost:11434/v1` and model `qwen2.5vl` — no editing needed.
3. Import a (scanned) PDF through the normal import form. The submit button ticks through "OCR page x/y…" as it runs; each page now goes to the local model instead of Apple Vision.

To switch back to the free, fast on-device engine, remove/deactivate the OCR provider — with none active, PDFs OCR on this Mac via Apple Vision.

## Using it — via the CLI

The same engine ships as `bin/hyperlit-ocr` (build with `./build-cli.sh` if it's missing). Point it at the local model with the `--vlm` flags:

```bash
bin/hyperlit-ocr some.pdf out.json --progress \
  --vlm http://localhost:11434/v1 --vlm-model qwen2.5vl
```

Without `--vlm` it uses the geometric/Apple-Vision engine. `--progress` prints `PROGRESS:{…}` lines so the import UI can show live page counts.

## Choosing a different model

Any vision-capable Ollama model works — pull it, then set the model field (app preset or `--vlm-model`) to its tag:

- **`qwen2.5vl`** (~6 GB) — the default and best all-round OCR reader. Use this.
- **`qwen2.5vl:3b`** (~3.2 GB) — smaller/faster fallback if 7B is too slow; weaker on small footnote markers.
- **`llama3.2-vision`** (~7.9 GB) — a llama-family vision model; it *works* but is a weaker OCR reader than qwen 7B, so there's no reason to prefer it here.

## Troubleshooting

- **"connection refused" / OCR falls back to Apple Vision** — the server isn't running. Start it (see above) and re-check `curl http://localhost:11434/api/version`.
- **Model not found** — the tag in Settings / `--vlm-model` must exactly match what `ollama list` shows (e.g. `qwen2.5vl`, which resolves to `qwen2.5vl:latest`).
- **Very slow / beachballing** — expected to a point (seconds per page), but if it's swapping hard you've likely pulled a model too big for RAM. Drop to a smaller tag.
- **Results worse than Apple Vision on a clean digital PDF** — that's normal; the vision model is for scans. Deactivate the provider for clean PDFs.
