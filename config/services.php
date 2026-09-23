<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'token' => env('POSTMARK_TOKEN'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'resend' => [
        'key' => env('RESEND_KEY'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    'openalex' => [
        // Free-account key = $1/day budget vs $0.10/day keyless (usage-based
        // pricing since 2026; searches cost 10x list calls). Sent as a Bearer
        // header, never a query param — request URLs get logged on 429s.
        'api_key' => env('OPENALEX_API_KEY'),
    ],

    'llm' => [
        'base_url'           => env('LLM_BASE_URL', 'https://api.fireworks.ai/inference/v1'),
        'api_key'            => env('LLM_API_KEY'),
        // Role models. Availability verified live against /v1/models 2026-06-11
        // (qwen3-8b was retired by Fireworks and silently 404'd — citation
        // metadata + truth-claim extraction failed quietly until swapped).
        // tests/Feature/CitationPipeline/LlmModelConfigTest.php fails if a
        // role model lands in retired_models or loses its pricing entry.
        'model'              => 'accounts/fireworks/models/gpt-oss-120b',
        'extraction_model'   => 'accounts/fireworks/models/gpt-oss-120b',
        'verification_model' => 'accounts/fireworks/models/deepseek-v4p1-flash',
        'embedding_model'    => 'nomic-ai/nomic-embed-text-v1.5',

        // Homepage semantic search: max cosine distance for a node to count as
        // a match (results beyond this are dropped in PHP after the HNSW scan).
        // Deliberately permissive — the UI shows the match % so users judge
        // closeness themselves. For scale (measured 2026-08-17): pure
        // gibberish still scores distance ~0.47 against this corpus (cosine has
        // a high noise floor), verbatim text ~0.015.
        'semantic_max_distance' => (float) env('SEMANTIC_SEARCH_MAX_DISTANCE', 0.6),

        // Zero point for the user-facing match %: cosine similarity never goes
        // near 0 for English-vs-English (gibberish measures ~0.53-0.55 against
        // this corpus), so the badge rescales the floor only —
        // match = (sim - floor) / (1 - floor) — leaving the top anchored at a
        // TRUE 100% (verbatim text ≈ 97, identical vectors = 100). One anchor,
        // no ceiling, no collapsed band.
        'semantic_match_floor' => (float) env('SEMANTIC_MATCH_FLOOR', 0.55),

        // In-book ("find in this text") semantic search has its OWN pair of
        // knobs, and the two above must not be reused for it: cosine's noise
        // floor is far higher WITHIN one document than across the corpus.
        // Measured on the chacko c128 source (the same corpus that calibrated
        // PassageSearcher::MIN_SEMANTIC_SIMILARITY): the passage that PROVED
        // the citation scored 0.73 while unrelated paragraphs OF THE SAME
        // DOCUMENT sat at ~0.67. With the homepage numbers those unrelated
        // paragraphs would badge at ~27% and the 0.6 distance cutoff would
        // admit literally every node in the book.
        //
        // min_similarity is the "this is noise, not a hit" drop, reusing
        // PassageSearcher's measured 0.55; match_floor is the zero point of
        // the badge, set just under the in-document noise level so a
        // topically-adjacent paragraph reads as a low percentage rather than a
        // confident one. Same floor-only rescale as the homepage —
        // match = (sim - floor) / (1 - floor), top unclamped, no ceiling.
        //
        // MEASURED against the `capital` book (5243 embedded nodes), 2026-09-21
        // — the anchors to re-check if either number is ever moved:
        //   "recipes for sourdough bread"            → 0 results (min_similarity
        //                                              refuses the whole book)
        //   "why capitalism keeps breaking down"     → 9-16%  (sim 0.68-0.71)
        //   "crisis of overproduction"               → 33-44% (sim 0.76-0.81)
        //   "the tendency of the rate of profit…"    → 53-55% (sim 0.84)
        //   a sentence quoted VERBATIM from the book → 49%    (sim 0.82)
        //
        // That last one is not a bug and must not be "fixed" by rescaling: a
        // node is a whole PARAGRAPH, so a one-sentence query is only ever
        // partially similar to the paragraph containing it. In-book scores
        // therefore top out near 55% in practice, where the homepage's
        // verbatim case reaches ~97% (there the query is the whole node). The
        // scale still separates cleanly across that narrower range, which is
        // what matters; as in PassageSearcher, the ORDERING does the real work.
        'semantic_in_book_min_similarity' => (float) env('SEMANTIC_IN_BOOK_MIN_SIMILARITY', 0.55),
        'semantic_in_book_match_floor' => (float) env('SEMANTIC_IN_BOOK_MATCH_FLOOR', 0.65),

        // BYO-key inference tickets — ClientTicketTransport defaults (callers may
        // pass explicit values). Tests shrink these to avoid real waits.
        'ticket_ttl_seconds'  => (int) env('LLM_TICKET_TTL', 300),
        'ticket_wait_seconds' => (int) env('LLM_TICKET_WAIT', 300),
        'ticket_poll_seconds' => (int) env('LLM_TICKET_POLL', 1),

        'pricing' => [
            // Fireworks AI — cost per 1M tokens (USD). Verified live 2026-05-27.
            // deepseek-v4p1-flash replaces deepseek-v4-pro-0813 (Fireworks
            // decommissions 0813 from serverless 2026-09-25 — DeepSeek itself
            // retired V4-Pro in favor of Flash, which beats it on most
            // benchmarks except GPQA/HLE-text). Verified 2026-09-23.
            'accounts/fireworks/models/deepseek-v4p1-flash'     => ['input' => 0.22, 'output' => 0.66],
            // Retired on Fireworks — kept for cost lookup on historical ledger rows
            'accounts/fireworks/models/deepseek-v4-pro-0813'    => ['input' => 1.74, 'output' => 3.48],
            'accounts/fireworks/models/deepseek-v4-pro'         => ['input' => 1.74, 'output' => 3.48],
            'accounts/fireworks/models/kimi-k2p6'               => ['input' => 0.95, 'output' => 4.00],
            'accounts/fireworks/models/kimi-k2p5'               => ['input' => 0.60, 'output' => 3.00],
            'accounts/fireworks/models/glm-5p1'                 => ['input' => 1.40, 'output' => 4.40],
            'accounts/fireworks/models/gpt-oss-120b'            => ['input' => 0.15, 'output' => 0.60],
            // Retired on Fireworks — kept for cost lookup on historical ledger rows
            'accounts/fireworks/models/qwen3-8b'                => ['input' => 0.20, 'output' => 0.20],
            'accounts/fireworks/models/deepseek-v3p2'           => ['input' => 0.56, 'output' => 1.68],
            'accounts/fireworks/models/deepseek-v3p1'           => ['input' => 0.56, 'output' => 1.68],
            'accounts/fireworks/models/llama-v3p3-70b-instruct' => ['input' => 0.90, 'output' => 0.90],
            'accounts/fireworks/models/minimax-m2p5'            => ['input' => 0.30, 'output' => 1.20],
            'nomic-ai/nomic-embed-text-v1.5'                   => ['input' => 0.008, 'output' => 0.0],
            // DeepInfra (OpenAI-compatible at https://api.deepinfra.com/v1/openai) — priced
            // ahead of use so pointing LLM_BASE_URL/LLM_MODEL there is costed from day one.
            // Gemma 4 is the hosted translation candidate: Fireworks lists gemma-4-31b-it as
            // "serverless: NOT supported" (on-demand GPU only), DeepInfra serves it per-token.
            // Rates from deepinfra.com/pricing, checked 2026-07-30.
            'google/gemma-4-31B-it'                            => ['input' => 0.13, 'output' => 0.38],
            // Mistral OCR — RAW cost per 1K pages (USD) we pay Mistral (the tier multiplier in
            // billing_tiers stacks on top). Keyed by the SERVED model id recorded in
            // ocr_response.json, so a book is billed at what its OCR actually cost. Prices are
            // Mistral list rates for the synchronous /v1/ocr endpoint (Batch would be ~half).
            // Verified 2026-07-12. `latest` currently resolves to OCR 4 — kept at the OCR-4 rate for
            // historical ledger rows stamped `mistral-ocr-latest` before the pin to 2512.
            'mistral-ocr-2512'   => ['per_1k_pages' => 2.00],   // OCR 3 — the pinned production model
            'mistral-ocr-4-0'    => ['per_1k_pages' => 4.00],   // OCR 4
            'mistral-ocr-latest' => ['per_1k_pages' => 4.00],   // alias → OCR 4 (historical rows only)
        ],
        // Models Fireworks no longer serves (404 on chat/completions). A model
        // moves here when it leaves /v1/models; no configured role or fallback
        // chain may reference one (drift-tested). Keep pricing entries above
        // for historical ledger cost lookups.
        'retired_models' => [
            'accounts/fireworks/models/qwen3-8b',
            'accounts/fireworks/models/deepseek-v3p2',
            'accounts/fireworks/models/deepseek-v3p1',
            'accounts/fireworks/models/llama-v3p3-70b-instruct',
            'accounts/fireworks/models/minimax-m2p5',
            'accounts/fireworks/models/deepseek-v4-pro-0813', // decommissioned 2026-09-25, 7PM PST
            'accounts/fireworks/models/deepseek-v4-pro',      // preview id, decommissioned 2026-08-27
        ],
    ],

    'billing_tiers' => [
        // user.status => multiplier on top of raw API costs
        'premium'    => ['multiplier' => 1.0,  'label' => 'Premium'],      // unlimited sub, no per-use markup
        'budget'     => ['multiplier' => 1.5,  'label' => 'Budget'],       // pay-as-you-go + overhead
        'solidarity' => ['multiplier' => 2.0,  'label' => 'Solidarity'],   // voluntary higher rate
        'capitalist' => ['multiplier' => 5.0,  'label' => 'Honest Capitalist'],   // institutional
    ],

    'billing' => [
        // When ON, a FAILED PDF import still bills the OCR that actually ran
        // before the crash (the Mistral call is a real cost even when a later
        // stage dies). Default OFF: failed imports cost the user nothing and
        // hyperlit eats the OCR spend. Wired in ProcessDocumentImportJob::failed();
        // the failure email tells the user which way it went. billOcrForBook's
        // marker + no-ocr_response.json guards make it safe either way.
        'charge_ocr_on_failed_import' => (bool) env('BILLING_CHARGE_OCR_ON_FAILED_IMPORT', false),
    ],

    'mistral_ocr' => [
        'api_key' => env('MISTRAL_OCR_API_KEY'),
        // Single source of truth for the OCR model we run. Pinned to OCR 3 (mistral-ocr-2512):
        // best footnote coverage (with the footer-fold) at half OCR 4's cost, and reproducible
        // (NOT the moving `-latest` alias, which silently became OCR 4 and doubled cost). Passed to
        // the Python pipeline via PdfProcessor's --ocr-model and used as the pricing fallback when a
        // served-model id isn't available (estimates / pre-OCR previews).
        'model' => env('MISTRAL_OCR_MODEL', 'mistral-ocr-2512'),
    ],

    // On-device PDF OCR (Apple Vision/PDFKit via the hyperlit-ocr CLI — build
    // with macOShyperlit/build-cli.sh). Only meaningful when the backend runs
    // on a Mac (local dev via Herd); production Linux leaves this unset.
    // provider: 'auto' = use the native binary when configured+executable,
    // else Mistral; 'native' = require it; 'mistral' = never use it.
    'native_ocr' => [
        'binary' => env('NATIVE_OCR_BINARY'),
        'provider' => env('OCR_PROVIDER', 'auto'),
    ],

    // Per-node TTS audiobook generation (GenerateBookAudioJob). Provider is
    // swappable via TtsProviderInterface; 'deepinfra' serves open-weight
    // Kokoro-82M and returns MP3 directly (no server-side transcode).
    // Packaging the per-node MP3s into one .m4b with chapters
    // (App\Services\Audiobook\AudiobookBuilder). Needs ffmpeg + ffprobe ON THE
    // HOST — `apt install ffmpeg`. Absent, the download button simply never
    // appears; nothing else is affected.
    'audiobook' => [
        'ffmpeg' => env('FFMPEG_BINARY', 'ffmpeg'),
        'ffprobe' => env('FFPROBE_BINARY', 'ffprobe'),
        // AAC mono. The source is only 24kHz mono (~58kbps VBR mp3), so a higher
        // rate buys nothing audible — 32k is about what commercial audiobooks
        // ship spoken word at, and it is 30% smaller than 48k. Measured on a
        // real book: 48k→31MB, 40k→25MB, 32k→21MB, 24k→16MB. Matters because the
        // .m4b is a DERIVED copy on top of the per-node mp3s it is built from
        // (~86% storage overhead per book that anyone downloads).
        'bitrate' => env('AUDIOBOOK_BITRATE', '32k'),
        'timeout' => 3000,                            // seconds, under the job's 3600
    ],

    'tts' => [
        'provider' => env('TTS_PROVIDER', 'deepinfra'),
        'api_key' => env('TTS_API_KEY'),
        'base_url' => env('TTS_BASE_URL', 'https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M'),
        'voice' => env('TTS_DEFAULT_VOICE', 'af_heart'),
        'bitrate_kbps' => 64,               // CBR mp3 — duration is estimated from this
        'max_chars_per_request' => 1500,    // sentence-split nodes above this
        'concurrency' => 5,                 // parallel provider requests per batch
        'pricing' => [
            'provider_cost_per_million_chars' => 0.80, // DeepInfra Kokoro-82M, checked 2026-07-06
            'billed_per_million_chars' => 1.00,        // raw rate passed to BillingService::charge (tier multiplier applies on top)
        ],
    ],

    // Machine translation. Provider is swappable via TranslationProviderInterface.
    //
    // WHY THREE PROVIDERS: as of 2026-07 neither specialised open translation model
    // is reachable per-token from any host — TranslateGemma (4B/12B/27B) and Hy-MT2
    // (1.8B/7B/30B-A3B) both report "not deployed by any Inference Provider" on HF.
    // So the three real deployment shapes each get a provider, and which one runs is
    // one env var:
    //   'hosted'    — rides services.llm.* (LlmService), so a general instruct model
    //                 prompted to translate. The ONLY one that works with no extra
    //                 setup, and the only one BYO inference tickets pass through
    //                 (ClientTicketTransport intercepts inside LlmService::chat*).
    //   'ollama'    — a local specialised model (`ollama pull translategemma:4b`).
    //                 Free, and the ONLY option for E2EE books, whose plaintext can
    //                 never reach the server (EncryptedBookGuard).
    //   'dedicated' — any OpenAI-compatible endpoint: a rented DeepInfra custom-LLM
    //                 deployment (GPU-hour, ~$0.89/hr A100, min_instances 0 scales to
    //                 zero) or a self-hosted box reached over Tailscale.
    'translation' => [
        'provider' => env('TRANSLATION_PROVIDER', 'hosted'),

        'batch_size' => 30,                 // texts per LLM batch (mirrors the citation-metadata chunking)
        'concurrency' => 5,                 // parallel provider requests per batch
        'max_chars_per_request' => (int) env('TRANSLATION_MAX_CHARS', 4000),
        'timeout' => (int) env('TRANSLATION_TIMEOUT', 120),

        // BYO-key inference waits: deliberately SHORTER than the shared
        // services.llm.ticket_* defaults (300s). Those serve an SSE stream and a
        // queue job, where blocking is free; translation is a synchronous request
        // a reader is waiting on, so a 5-minute hold would read as a hung page.
        'byo_ttl_seconds' => (int) env('TRANSLATION_BYO_TTL', 300),
        'byo_wait_seconds' => (int) env('TRANSLATION_BYO_WAIT', 90),

        'hosted' => [
            // Transport is services.llm.base_url + api_key — NOT a separate key. Only
            // the model differs, so translation can use a different model from the
            // citation/brain roles on the same endpoint.
            // ⚠ If you repoint LLM_BASE_URL at DeepInfra, set TRANSLATION_MODEL too —
            // this default is a Fireworks id and would 404 there.
            'model' => env('TRANSLATION_MODEL', 'accounts/fireworks/models/gpt-oss-120b'),
            'temperature' => 0.0,           // translation is not a creative task
        ],

        'ollama' => [
            'base_url' => env('TRANSLATION_OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
            'model' => env('TRANSLATION_OLLAMA_MODEL', 'translategemma:4b'),
            // TranslateGemma's chat template takes a STRUCTURED content part
            // ({type,source_lang_code,target_lang_code,text}) rather than a
            // natural-language instruction. Whether Ollama's bundled template
            // accepts that is probed by tests/translation/probe-template.php;
            // 'auto' tries structured and falls back to an instruction string.
            'request_shape' => env('TRANSLATION_OLLAMA_SHAPE', 'auto'), // auto|structured|instruction
            // No API key: Ollama is unauthenticated on localhost. Never bill for it.
        ],

        'dedicated' => [
            'base_url' => env('TRANSLATION_DEDICATED_BASE_URL'),
            'api_key' => env('TRANSLATION_DEDICATED_API_KEY'),
            'model' => env('TRANSLATION_DEDICATED_MODEL'),
            'request_shape' => env('TRANSLATION_DEDICATED_SHAPE', 'instruction'),
            // Cost per 1M tokens for a rented endpoint is GPU-hour, not per-token, so
            // there is no honest per-token rate to bill. Left null deliberately: the
            // controller waives the charge rather than invent a number.
            'pricing' => null,
        ],
    ],

    /*
     * Citation review — truth-claim extraction.
     *
     * span_backfill: use OUR deterministic sentence span (CitationParser's sentenceAtPosition /
     * precedingClauseSpan) when the LLM fails to echo it back, and create a claim for any citation
     * the model omitted entirely. Off reproduces the historical behaviour, in which such a citation
     * is silently dropped and never reviewed — measured at 0-9% of a book's linked citations on the
     * 2026-09-18 phase2 run. Subject of the 2026-09-19 A/B; see docs/prompts and the study notes.
     */
    'citation_review' => [
        'span_backfill' => (bool) env('CITATION_CLAIM_SPAN_BACKFILL', false),

        /*
         * What the support scale is measured AGAINST — the study's open methodological question,
         * switchable so both can be RUN and compared rather than argued about.
         *
         *   'strict'   (default, historical): does the source support the whole CLAIM SENTENCE.
         *   'fragment': does the source support the COMPONENT this citation was attached to.
         *
         * Changing this changes what a verdict MEANS, so record it with any run: `unlikely` under
         * strict and `likely` under fragment can both be correct about the same citation. Ground
         * truth is labelled as what the citation actually supports, which scores either variant.
         */
        'verify_scope' => env('CITATION_VERIFY_SCOPE', 'strict'),
    ],

    'brave_search' => [
        'api_key' => env('BRAVE_SEARCH_API_KEY'),
        // Brave's "Search" plan list price, USD per 1,000 requests. Billed to
        // the user like OCR pages and LLM tokens (see docs/billing.md) — it is
        // a real per-citation cost that scales with how many references a
        // document has. The free $5/month credit is deliberately NOT modelled:
        // the charge is the marginal list price, and the credit is ours.
        'price_per_1k_requests' => (float) env('BRAVE_SEARCH_PRICE_PER_1K', 5.00),
    ],

    'semantic_scholar' => [
        'api_key' => env('SEMANTIC_SCHOLAR_API_KEY'),
    ],

    // Unpaywall — free green-OA index (richest source of repository PDFs).
    // Keyless, but the API requires a contact email query param.
    'unpaywall' => [
        'email' => env('UNPAYWALL_EMAIL'),
    ],

    // CORE (core.ac.uk) — OA aggregator with its own PDF cache. Key is free
    // (email registration); without it the API rate-limits hard and the
    // fullText/TEI fields return a placeholder. Auth: Bearer token header.
    // NOTE: a record's downloadUrl can 404 even with fulltextStatus=enabled —
    // treat CORE as one ladder rung, never a trusted source of truth.
    'core' => [
        'api_key' => env('CORE_API_KEY'),
    ],

    // FlareSolverr — self-hosted Cloudflare-challenge solver. Unset = the
    // Cloudflare-solver fetch strategy no-ops. See deploy/oa-fetch-hardening.md.
    'flaresolverr' => [
        'url'         => env('FLARESOLVERR_URL'),
        'max_timeout' => env('FLARESOLVERR_MAX_TIMEOUT', 60000), // ms
    ],

    // Optional residential/rotating proxy for OA fetches + the browser scripts.
    // Cloudflare hard-blocks datacenter IPs by reputation; a residential egress
    // is often the actual fix. Unset = fetch from the server's own IP.
    'source_fetch' => [
        'proxy' => env('SOURCE_FETCH_PROXY'),
        // Per-work sticky-session suffix appended to the proxy password so the
        // Cloudflare solve and the PDF download share ONE residential IP
        // (cf_clearance is IP-bound). `{id}` is replaced with a per-work random
        // token. IPRoyal's format; empty = plain rotating proxy (unchanged).
        'sticky_suffix' => env('SOURCE_FETCH_STICKY_SUFFIX', '_session-{id}_lifetime-10m'),
        // Run the challenge-solving browser headed (headless loses managed
        // challenges — proven by the Phase 0 spike). On Linux, wrap in xvfb.
        'headful' => env('SOURCE_FETCH_HEADFUL', true),
        // The Playwright rung at all. It is an optional HOST capability (needs
        // patchright installed) and the expensive one — a failed attempt costs
        // the full 70s process timeout. Off = the plain proxied GET is the only
        // channel, which is what tests want: Http::fake cannot reach into a Node
        // subprocess, so an unstubbed browser rung turns a gate test into a
        // multi-minute hang.
        'browser' => env('SOURCE_FETCH_BROWSER', true),
        // Budget (ms) for ONE browser escalation during CITATION resolution.
        // Harvest gives the browser ~62s because a single article is worth the
        // wait; a citation review runs dozens of URLs in one pass, so a
        // hard-walled page spending a full minute to conclude "blocked" is a
        // minute of nothing (measured at 62.5s each for thewalrus.ca and
        // fbi.gov in one chacko bench). 20s still clears a plain JS render and
        // most intermittent Cloudflare 403s. Set 0 to use harvest's default.
        'citation_browser_budget_ms' => (int) env('CITATION_BROWSER_BUDGET_MS', 20000),
        // Let CITATION resolution ratchet a walled host onto the residential
        // proxy (harvest always does; this is the citation path only). Default
        // OFF on measured evidence: over chacko's 59 unresolved URLs a live
        // residential IP recovered ZERO pages the datacenter IP could not get,
        // while costing ~4MB of metered bandwidth per blocked page. The blocks
        // that remain are managed challenges patchright loses whatever the exit
        // IP. Measure with `citation:web:bench` before turning this on.
        'citation_proxy_escalation' => (bool) env('CITATION_PROXY_ESCALATION', false),
        // How long a FAILED web-source verification is believed before the
        // vacuum stage will spend another browser fetch on that URL.
        //
        // Measured on chacko: 36 of 52 unverified stubs carried a recorded wall
        // (13 Cloudflare, 7 Akamai, 5 reCAPTCHA, 1 PerimeterX, plus body-absent
        // pages) — and because importWebSource writes the reason to
        // `pdf_url_status` while leaving `conversion_method` NULL, and the
        // vacuum query selects on `conversion_method IS NULL`, every one of
        // them was re-fetched on EVERY run, forever. A week, because bot walls
        // are rate-based and do occasionally lift, but not within a rerun.
        // `citation:pipeline --refetch-walled` overrides it.
        'web_verify_retry_hours' => (int) env('WEB_VERIFY_RETRY_HOURS', 168),
        // USD charged per browser escalation during a citation review. The real
        // marginal cost is residential-proxy bandwidth (a rendered article page
        // pulls a few MB at single-digit dollars per GB) plus the browser
        // process itself. Deliberately a flat per-fetch rate rather than
        // metered bytes: we cannot see the proxy's accounting, and a stable
        // number the user can predict beats a precise one they cannot. Set 0 to
        // absorb the cost.
        'browser_fetch_price' => (float) env('BROWSER_FETCH_PRICE', 0.01),
    ],

    /**
     * Managed unblocking endpoint — the vendor runs the browser and the
     * anti-bot fingerprinting; we send a URL and get HTML. Dormant until
     * UNBLOCKER_URL is set, exactly like FlareSolverr above it.
     *
     * The rung it serves: ~21 of chacko's 59 unresolved citation URLs are
     * managed Cloudflare/PerimeterX challenges our own patchright stack loses
     * whatever the exit IP (a live residential proxy recovered ZERO of them —
     * measured 24/59 direct vs 23/59 proxied). These services bill per
     * SUCCESSFUL retrieval, so failures are free and the whole blocked set
     * costs roughly a penny.
     *
     * `mode`: 'proxy' for endpoints that ARE an HTTP proxy (IPRoyal Web
     * Unblocker, Bright Data), 'api' for ones that take the URL as JSON.
     */
    'unblocker' => [
        'url' => env('UNBLOCKER_URL'),
        'mode' => env('UNBLOCKER_MODE', 'proxy'),
        'username' => env('UNBLOCKER_USERNAME'),
        'password' => env('UNBLOCKER_PASSWORD'),
        'token' => env('UNBLOCKER_TOKEN'),
        // JS RENDERING. By default the unblocker does a plain HTTP request and
        // returns whatever came back — which for a client-rendered site is an
        // empty app shell at HTTP 200 (measured: thewire.in came back
        // byte-identical to a direct fetch, 11,192 bytes of shell). Rendering
        // is opt-in per request, and IPRoyal signals it by a SUFFIX ON THE
        // PASSWORD, the same mechanism as the residential sticky-session
        // suffix above. Default ON: this rung only fires when the cheap path
        // already failed, so there is nothing to save by asking for less.
        'render' => (bool) env('UNBLOCKER_RENDER', true),
        'render_suffix' => env('UNBLOCKER_RENDER_SUFFIX', '_render-1'),
        'timeout' => (int) env('UNBLOCKER_TIMEOUT', 90),
        // These endpoints terminate TLS themselves — that IS the mechanism —
        // so their certificate is not the target's.
        'verify_tls' => (bool) env('UNBLOCKER_VERIFY_TLS', false),
        // USD per successful retrieval, billed like the Brave and browser
        // line items. 0 absorbs it.
        'price_per_fetch' => (float) env('UNBLOCKER_PRICE_PER_FETCH', 0.0007),
        // Heap ceiling (MB) for the paste-engine Node subprocess. EXPLICIT on purpose: Node
        // derives its default from total system RAM, so the same article converts on a dev
        // machine (4GB ceiling) and aborts on a 2GB droplet — with nothing in dmesg, because
        // Node self-aborts (SIGABRT) rather than the kernel OOM-killing it. Measured: a 900KB
        // Atypon page peaks around 580MB. 0 = don't pass the flag (use Node's default).
        'paste_engine_heap_mb' => (int) env('PASTE_ENGINE_HEAP_MB', 1024),

        // ── Pacing ──
        // How hard a harvest leans on one publisher. Tunable because the right answer is a
        // property of THEIR rate rules, not ours: Bristol (AWS WAF) began issuing CAPTCHAs partway
        // through a 25-work batch, which is the signature of a rate-based rule rather than a ban.
        // Raise these if a publisher starts challenging mid-run; both cost only wall-clock.
        //
        // Seconds between WORKS in a bulk run (the CLI's --sleep default too, so both paths agree).
        'work_sleep_seconds' => (int) env('HARVEST_WORK_SLEEP', 2),
        // Milliseconds between an article's IMAGE downloads. Load-bearing alongside the above: a
        // figure-heavy article otherwise fires a dozen requests at the same host inside one
        // inter-work gap, which is a burst no per-article pause smooths out.
        'image_delay_ms' => (int) env('HARVEST_IMAGE_DELAY_MS', 400),
        // Seconds before the one fresh-IP retry. Not a rate lever — just politeness about
        // re-asking a question that was already refused once.
        'retry_delay_seconds' => (int) env('HARVEST_RETRY_DELAY', 3),
    ],

    'stripe' => [
        'key'            => env('STRIPE_KEY'),
        'secret'         => env('STRIPE_SECRET'),
        'webhook_secret' => env('STRIPE_WEBHOOK_SECRET'),
    ],

];
