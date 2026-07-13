<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        channels: __DIR__.'/../routes/channels.php',
        health: '/up',
        // Add this to include auth routes
        then: function () {
            Route::middleware('web')
                ->group(base_path('routes/auth.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware) {
        // Trust the fronting proxy so $request->ip() is the REAL client IP behind a CDN.
        // SECURITY: `at: '*'` blanket-trusts every hop, so an attacker could spoof
        // X-Forwarded-For and mint a fresh per-IP rate-limit bucket on every request —
        // bypassing all per-IP throttles (RateLimitingTest). Trust ONLY the fronting proxy:
        // Cloudflare's published ranges by default, overridable via TRUSTED_PROXIES
        // (comma-separated IPs/CIDRs, or the literal '*' if you terminate behind your own
        // trusted LB). Anything else's X-Forwarded-For is ignored → the true socket IP is used.
        $trustedProxies = env('TRUSTED_PROXIES');
        $middleware->trustProxies(at: $trustedProxies === null
            ? [
                // Cloudflare IPv4 — https://www.cloudflare.com/ips/
                '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
                '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
                '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
                '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
                // Cloudflare IPv6
                '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
                '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
            ]
            : ($trustedProxies === '*' ? '*' : array_map('trim', explode(',', $trustedProxies))));

        // Add RLS context middleware to set PostgreSQL session variables
        // This must run after session starts but before any database queries
        $middleware->appendToGroup('web', [
            \App\Http\Middleware\SetDatabaseSessionContext::class,
        ]);

        // Add CORS and security headers middleware for API routes
        $middleware->api(prepend: [
            \App\Http\Middleware\SecurityHeaders::class,
            \App\Http\Middleware\CorsMiddleware::class,
            \Laravel\Sanctum\Http\Middleware\EnsureFrontendRequestsAreStateful::class,
        ]);

        // Add RLS context for API routes too
        $middleware->appendToGroup('api', [
            \App\Http\Middleware\SetDatabaseSessionContext::class,
        ]);

        // Add CORS and security headers middleware for web routes
        $middleware->web(append: [
            \App\Http\Middleware\SecurityHeaders::class,
            \App\Http\Middleware\CorsMiddleware::class,
        ]);
        
        // CSRF token validation - only exempt truly stateless endpoints
        // Most API routes now protected by CSRF since they're used by the SPA
        $middleware->validateCsrfTokens(except: [
            'api/login',
            'api/register',
            'api/auth-check',
            'api/anonymous-session',
            'api/password/forgot',
            'api/password/reset',
            'api/search/*',            // Public search endpoints
            'api/database-to-indexeddb/*',  // Public read-only data endpoints
            'api/stripe/webhook',          // Stripe webhook (signature-verified)
        ]);
        
        $middleware->alias([
            'book.owner' => \App\Http\Middleware\CheckBookOwnership::class,
            'author'     => \App\Http\Middleware\RequireAuthor::class,
            'cors'       => \App\Http\Middleware\CorsMiddleware::class, // Add alias for manual use
            'admin'      => \App\Http\Middleware\RequireAdmin::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // Global exception handler for consistent API error responses
        $exceptions->render(function (Throwable $e, \Illuminate\Http\Request $request) {
            // Only handle API/JSON requests
            if ($request->expectsJson() || $request->is('api/*')) {
                $status = 500;

                // Get appropriate status code from exception
                if (method_exists($e, 'getStatusCode')) {
                    $status = $e->getStatusCode();
                } elseif ($e instanceof \Illuminate\Auth\AuthenticationException) {
                    $status = 401;
                } elseif ($e instanceof \Illuminate\Auth\Access\AuthorizationException) {
                    $status = 403;
                } elseif ($e instanceof \Illuminate\Database\Eloquent\ModelNotFoundException) {
                    $status = 404;
                } elseif ($e instanceof \Illuminate\Validation\ValidationException) {
                    $status = 422;
                }

                // Sanitize error message in production
                $message = $e->getMessage();
                if ($status === 500 && !config('app.debug')) {
                    $message = 'An unexpected error occurred';
                }

                // Log full details server-side for debugging
                if ($status >= 500) {
                    \Illuminate\Support\Facades\Log::error('API Exception', [
                        'exception' => get_class($e),
                        'message' => $e->getMessage(),
                        'file' => $e->getFile(),
                        'line' => $e->getLine(),
                        'url' => $request->fullUrl(),
                        'method' => $request->method(),
                    ]);
                }

                $response = [
                    'success' => false,
                    'message' => $message,
                ];

                // Include validation errors if applicable
                if ($e instanceof \Illuminate\Validation\ValidationException) {
                    $response['errors'] = $e->errors();
                }

                // Include error type for debugging (safe to expose)
                $response['error_type'] = class_basename($e);

                return response()->json($response, $status);
            }
        });
    })->create();