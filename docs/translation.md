# Translation

Machine translation of passages. **This is plumbing only** — a provider seam, a language/script registry, and an endpoint. There is no UI, no cache table, and no whole-book mode, because those depend on a product decision that has not been made and on a technical problem that has not been solved (see "What is deliberately missing").

## Why the shape is what it is

As of 2026-07 neither leading open translation model is reachable per-token from any host. TranslateGemma (4B/12B/27B, Gemma 3 base) and Hy-MT2 (1.8B/7B/30B-A3B) both report "not deployed by any Inference Provider" on Hugging Face. Fireworks — the current `LLM_BASE_URL` — has no translation models and lists `gemma-4-31b-it` as serverless-unsupported (dedicated GPUs only). DeepInfra has no translation models either, though it does serve `google/gemma-4-31B-it` per-token at $0.13/$0.38 per 1M tokens.

So using a specialist means running it yourself, and that is a per-GPU-hour expense: a DeepInfra custom-LLM deployment on an A100-80GB is $0.89/hr, roughly $650/month always-on, or `min_instances: 0` scale-to-zero at the cost of a multi-minute cold start. Every model in question fits on one A100, so size is irrelevant — one GPU is the minimum billable unit. Against roughly $0.08 to translate a whole 100k-word book on hosted serverless, break-even is north of 8,000 books a month.

The seam exists so that decision stays out of the code. Which model answers is one env var.

## The three providers

Selected by `TRANSLATION_PROVIDER` and bound in `AppServiceProvider`; all implement `TranslationProviderInterface`.

- **`hosted`** (default) — a general instruct model via `LlmService`. The only one that works with no extra setup, and the only one BYO-key inference tickets traverse, because `ClientTicketTransport` is checked *inside* `LlmService::chat*`. It rides `LlmService` rather than its own HTTP client on purpose: BYO routing, per-model usage accounting (which billing prices from) and retry/backoff all come for free, and a separate client would silently bypass all three.
- **`ollama`** — a local specialised model. Free, and the **only** provider that can translate an E2EE book, whose plaintext must never reach the server.
- **`dedicated`** — any OpenAI-compatible endpoint: a rented GPU-hour deployment, or your own machine over Tailscale. Not billable, deliberately — a GPU-hour has no honest per-token rate, and inventing one would put a fabricated number in the immutable ledger.

## The two request shapes, and the Shahmukhi trap

TranslateGemma's chat template takes a *structured content part* — `{"type":"text","source_lang_code":"en","target_lang_code":"pa","text":"…"}` — not an instruction. That is its native interface and should give its best output, but it has no slot for anything else: it cannot express "in the Shahmukhi script", and it requires a known source language. Hy-MT2 and every general model expect an ordinary instruction chat instead.

`request_shape: auto` (the default) uses structured **except** where structured would lose information — a split-script target or an unknown source. Getting this backwards is exactly how a Shahmukhi request comes back silently rendered in Gurmukhi. Whether Ollama's bundled template actually honours the structured fields is an empirical question about the packaging; run `php tests/translation/probe-template.php` to find out.

## Script is a first-class field

`LanguageRegistry` keys on codes carrying the script where it matters: `pa-Guru` (Gurmukhi, Indian Punjabi) vs `pa-Arab` (Shahmukhi, Pakistani), `zh-Hans` vs `zh-Hant`, `sr-Cyrl` vs `sr-Latn`. A bare `pa` is not a specification — it resolves to Gurmukhi and the response says `target_was_ambiguous: true`.

`ScriptDetector` then checks the answer actually came back in that writing system. This is production code, not test tooling, because the characteristic failure of every model claiming "Punjabi" is fluent, confident output in the wrong script — which no length, JSON or language-detect check catches, but code points catch trivially. A failure sets `script_ok: false` and `wrong_script: true` on the response. Known limit: Simplified and Traditional Han share Unicode ranges, so a passing Han check does not confirm the variant.

## Support tiers

Coverage claims for these models are not verifiable to the standard billing deserves, so `LanguageRegistry` records three states rather than a boolean.

- **supported** — in the model's own published, enumerated set. Only Hy-MT2's 33 languages qualify today.
- **unsupported** — enumerated as absent. Hy-MT2 has no Punjabi; this is a documented fact, and the only tier that refuses (422, `reason: unsupported`).
- **unverified** — the default, including all of TranslateGemma. Google reports 55 benchmarked languages against WMT24++ while the chat template enumerates about 160, and the 55-list could not be sourced authoritatively — third-party reproductions disagree with each other, including on Punjabi. Allowed, but the response carries `unverified: true` so a UI can say so rather than presenting an unproven translation as sound.

An unknown language code is a fourth, distinct state (`reason: unknown`) — the caller's mistake, not a model gap.

## Source text

`TranslatableText::fromContent()` derives what gets translated, always from `content` and never from `nodes.plainText` (write-path-unreliable and contaminated — see `SpeakableText`'s docblock for the evidence).

It is deliberately a **separate class from `SpeakableText`, not a reuse of it**. `SpeakableText`'s output *is* the audio `source_hash` input, so sharing the derivation would mean a tweak made for a translator silently reflagging every audiobook as stale and re-billing its regeneration. The DOM-pass skeleton is copied; the rules diverge — a narrator and a translator want opposite things from the same furniture. Footnote markers are narrated as "(footnote 3)" for speech but **dropped** for translation, because narrating them gets the word "footnote" translated into the reader's prose.

## Billing

Charged after success, never before, into `billing_ledger` with category `translation`. Waived under BYO (the user's own key paid) and for providers that cost us nothing per token. Cost comes from `LlmService::getUsageStats()` priced against `services.llm.pricing`; a model with no pricing entry logs loudly rather than under-billing silently.

The endpoint is synchronous, so the queue-worker RLS trap does not apply here. **It will apply the moment a whole-book translation job exists**: `BillingService::charge()` sets `app.current_user` but the `users` policy also needs `app.current_token`, which HTTP middleware provides and a worker does not — a worker-side charge silently no-ops. Use the restoring pattern in `CitationReviewCommand::billReview`, not the blanking variant.

## What is deliberately missing

- **Per-node translation cache.** A `node_translations` table keyed `(book, node_id, target_lang)` with `source_hash` staleness, cloning the `book_audio` precedent. Held back until the model choice is settled, because the `source_hash` derivation freezes the moment rows exist.
- **Any UI.** No toolbar button, no settings-panel entry.
- **Book source language.** Not recorded anywhere; belongs on `library`, not `nodes`. Until then it is passed by the caller or detected.
- **Whole-book reading modes**, and with them the only genuinely hard problem here. Annotations are node-anchored, not book-anchored: `AnnotationRecordBase` is `node_id: string[]` plus `charData: Record<nodeId, CharRange>`, with no top-level offset. Because translation is per-node, node membership survives for free and only the offsets *within* a node break — and `highlightedText`/`highlightedHTML` are stored, so realignment is "find this substring in the translated paragraph" rather than offset arithmetic. Note that *peek* (a popover) and *interlinear* (original plus translation, original left in the DOM) need **no** remapping at all; only full replacement does.

## Evaluating models

`tests/translation/` — see its README. Probe the template first, then compare models over fixtures. The harness checks only what is mechanically verifiable (script, citation numbers, digit groups, paragraph structure, echo) and deliberately scores nothing else: quality between two decent models is not a number, and the judgement is the deliverable.
