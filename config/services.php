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
        'verification_model' => 'accounts/fireworks/models/deepseek-v4-pro',
        'embedding_model'    => 'nomic-ai/nomic-embed-text-v1.5',

        // BYO-key inference tickets — ClientTicketTransport defaults (callers may
        // pass explicit values). Tests shrink these to avoid real waits.
        'ticket_ttl_seconds'  => (int) env('LLM_TICKET_TTL', 300),
        'ticket_wait_seconds' => (int) env('LLM_TICKET_WAIT', 300),
        'ticket_poll_seconds' => (int) env('LLM_TICKET_POLL', 1),

        'pricing' => [
            // Fireworks AI — cost per 1M tokens (USD). Verified live 2026-05-27.
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
        ],
    ],

    'billing_tiers' => [
        // user.status => multiplier on top of raw API costs
        'premium'    => ['multiplier' => 1.0,  'label' => 'Premium'],      // unlimited sub, no per-use markup
        'budget'     => ['multiplier' => 1.5,  'label' => 'Budget'],       // pay-as-you-go + overhead
        'solidarity' => ['multiplier' => 2.0,  'label' => 'Solidarity'],   // voluntary higher rate
        'capitalist' => ['multiplier' => 5.0,  'label' => 'Honest Capitalist'],   // institutional
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

    'brave_search' => [
        'api_key' => env('BRAVE_SEARCH_API_KEY'),
    ],

    'semantic_scholar' => [
        'api_key' => env('SEMANTIC_SCHOLAR_API_KEY'),
    ],

    // Unpaywall — free green-OA index (richest source of repository PDFs).
    // Keyless, but the API requires a contact email query param.
    'unpaywall' => [
        'email' => env('UNPAYWALL_EMAIL'),
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
    ],

    'stripe' => [
        'key'            => env('STRIPE_KEY'),
        'secret'         => env('STRIPE_SECRET'),
        'webhook_secret' => env('STRIPE_WEBHOOK_SECRET'),
    ],

];
