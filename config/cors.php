<?php

/**
 * CORS Configuration
 *
 * 🔒 SECURITY: Explicitly whitelist allowed origins instead of using wildcards.
 * This prevents cross-origin attacks from arbitrary domains.
 */

return [
    /*
    |--------------------------------------------------------------------------
    | Cross-Origin Resource Sharing (CORS) Configuration
    |--------------------------------------------------------------------------
    |
    | Here you may configure your settings for cross-origin resource sharing
    | or "CORS". This determines what cross-origin operations may execute
    | in web browsers.
    |
    */

    'paths' => ['api/*', 'sanctum/csrf-cookie'],

    'allowed_methods' => ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],

    // 🔒 SECURITY: Explicit origin whitelist instead of '*'
    'allowed_origins' => array_filter([
        'http://127.0.0.1:8000',
        'http://localhost:8000',
        'http://localhost:5173',
        'https://libzen.com',
        'https://libzen.io',
        'https://hyperlit.io',
        'http://libzen.com',
        'http://libzen.io',
        'http://hyperlit.io',
        // Add from environment if set (comma-separated list)
        ...array_filter(explode(',', env('CORS_ALLOWED_ORIGINS', ''))),
    ]),

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-CSRF-TOKEN'],

    'exposed_headers' => [],

    'max_age' => 0,

    // Allow credentials for session-based auth
    'supports_credentials' => true,
];
