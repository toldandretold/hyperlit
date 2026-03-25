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
        'base_url' => env('LLM_BASE_URL', 'https://api.fireworks.ai/inference/v1'),
        'api_key'  => env('LLM_API_KEY'),
        'model'    => env('LLM_MODEL', 'accounts/fireworks/models/qwen3-8b'),
        'verification_model' => env('LLM_VERIFICATION_MODEL'),
    ],

    'mistral_ocr' => [
        'api_key' => env('MISTRAL_OCR_API_KEY'),
    ],

    'brave_search' => [
        'api_key' => env('BRAVE_SEARCH_API_KEY'),
    ],

];
