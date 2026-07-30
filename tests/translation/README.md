# Translation model evaluation

Tooling to answer one question: **is a specialised translation model worth what it costs to run, compared with the general model we can already call?**

## Why this exists

As of 2026-07 neither leading open translation model is reachable per-token from any host. TranslateGemma (4B/12B/27B) and Hy-MT2 (1.8B/7B/30B-A3B) both report "not deployed by any Inference Provider" on Hugging Face. Fireworks lists `gemma-4-31b-it` as serverless-unsupported (dedicated GPUs only); DeepInfra has no translation-specific models at all.

So using a specialist means running it yourself, and that has a real price. DeepInfra custom-LLM deployments bill per GPU-hour, not per token — an A100-80GB at $0.89/hr is roughly $650/month always-on, or `min_instances: 0` scale-to-zero at the cost of a multi-minute cold start while the weights load. Every model in question fits on one A100, so size barely matters; one GPU is the minimum billable unit either way. The alternative is around **$0.08 to translate an entire 100k-word book** on hosted serverless, which puts break-even north of 8,000 books a month.

That expense can only be justified by looking at output. Hence these scripts.

## Run order

**1. Probe the template.** Do this before anything else — it decides how `OllamaProvider` talks to the model, and no documentation can answer it.

```
ollama serve                      # separate terminal
ollama pull translategemma:4b
php tests/translation/probe-template.php
```

TranslateGemma's card specifies a *structured* content part (`{type, source_lang_code, target_lang_code, text}`) rather than an instruction prompt. Whether Ollama's bundled template actually renders those fields — as opposed to dropping them and echoing the source back — is a property of the packaging, not the model. The probe reports which shapes work and what to set `TRANSLATION_OLLAMA_SHAPE` to.

**2. Compare models.**

```
php tests/translation/run-eval.php
php tests/translation/run-eval.php --targets=pa-Arab,pa-Guru
php tests/translation/run-eval.php --models=translategemma:12b,hosted
```

Writes a side-by-side report to `tests/translation/out/compare.md` (gitignored — it costs money to produce and changes every run; the fixtures are committed).

## What is checked, and what is not

The script checks only what is mechanically verifiable, because machine translation quality between two decent models is not a number and pretending otherwise would launder a judgement call into a false measurement.

- **script** — output is in the target's writing system. This is the load-bearing one. Every model that advertises "Punjabi" is liable to accept a Shahmukhi request and answer in Gurmukhi, or transliterate into Latin — output that is fluent, confident and the wrong writing system. `ScriptDetector` catches it by code point.
- **citations** — bracketed reference numbers present in the source survive verbatim. Models renumber and drop them.
- **numbers** — digit groups survive, compared as a set (languages reorder) and normalised for thousands separators (which legitimately differ).
- **paragraphs** — a multi-paragraph source stays multi-paragraph.
- **echo** — output differs from the input, except for the already-in-target fixture, where it should be unchanged rather than paraphrased.

Not checked, and deliberately left to you: whether the prose is any good. Register, idiom, and whether a translated sentence says what the author meant. **That judgement is the deliverable** — the checks just stop you wasting attention on output that is broken in a way a machine could have told you about.

## Hardware notes for the local models

Measured on this repo's dev machine (M1 Pro, 16GB, ~200 GB/s memory bandwidth, GPU wired limit at default so roughly 10.5GB usable):

- `translategemma:4b` q4_K_M is about 2.5GB and runs comfortably.
- `translategemma:12b` q4_K_M is about 7.3GB and fits **only with the context capped** — its 128K window will exhaust unified memory through KV cache alone, well before the weights become the constraint. Run Ollama with `OLLAMA_CONTEXT_LENGTH=8192`.
- `Hy-MT2-7B` q4 is about 4.4GB and is comfortable. It cannot do Punjabi at all (enumerated as absent from its 33 languages), so it is in the comparison to show how much of any quality gap is "translation-specialised" versus "just a competent model".
- The 27B TranslateGemma is out of reach on 16GB.

## Adding fixtures

`fixtures.json` — one entry per source text, with the targets to render it into. Keep them short and real: prose of the kind Hyperlit actually holds. The `already-target` and `shahmukhi-direct` cases are load-bearing and should not be removed; the rest are a starting point and are meant to be replaced with your own material.
