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
        'model'              => 'accounts/fireworks/models/qwen3-8b',
        'extraction_model'   => 'accounts/fireworks/models/qwen3-8b',
        'verification_model' => 'accounts/fireworks/models/deepseek-v3p2',
        'embedding_model'    => 'nomic-ai/nomic-embed-text-v1.5',
        'pricing' => [
            // Fireworks AI — cost per 1M tokens (USD)
            'accounts/fireworks/models/qwen3-8b'     => ['input' => 0.20, 'output' => 0.20],
            'accounts/fireworks/models/deepseek-v3p2'           => ['input' => 0.56, 'output' => 1.68],
            'accounts/fireworks/models/deepseek-v3p1'           => ['input' => 0.56, 'output' => 1.68],
            'accounts/fireworks/models/llama-v3p3-70b-instruct' => ['input' => 0.90, 'output' => 0.90],
            'accounts/fireworks/models/minimax-m2p5'            => ['input' => 0.30, 'output' => 1.20],
            'nomic-ai/nomic-embed-text-v1.5'                   => ['input' => 0.008, 'output' => 0.0],
            // Mistral OCR — cost per 1K pages (USD)
            'mistral-ocr-latest' => ['per_1k_pages' => 1.00],
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
    ],

    'brave_search' => [
        'api_key' => env('BRAVE_SEARCH_API_KEY'),
    ],

    'semantic_scholar' => [
        'api_key' => env('SEMANTIC_SCHOLAR_API_KEY'),
    ],

    'stripe' => [
        'key'            => env('STRIPE_KEY'),
        'secret'         => env('STRIPE_SECRET'),
        'webhook_secret' => env('STRIPE_WEBHOOK_SECRET'),
    ],

];
