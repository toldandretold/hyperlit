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
            'api/search/*',            // Public search endpoints
            'api/database-to-indexeddb/*',  // Public read-only data endpoints
        ]);
        
        $middleware->alias([
            'book.owner' => \App\Http\Middleware\CheckBookOwnership::class,
            'author'     => \App\Http\Middleware\RequireAuthor::class,
            'cors'       => \App\Http\Middleware\CorsMiddleware::class, // Add alias for manual use
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