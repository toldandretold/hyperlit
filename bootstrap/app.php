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
        // Add CORS middleware for API routes
        $middleware->api(prepend: [
            \App\Http\Middleware\CorsMiddleware::class,
            \Laravel\Sanctum\Http\Middleware\EnsureFrontendRequestsAreStateful::class,
        ]);
        
        // Add CORS middleware for web routes too (in case you need it)
        $middleware->web(append: [
            \App\Http\Middleware\CorsMiddleware::class,
        ]);
        
        // CSRF token validation - only exempt truly stateless endpoints
        // Most API routes now protected by CSRF since they're used by the SPA
        $middleware->validateCsrfTokens(except: [
            'api/login',
            'api/register',
            'api/auth-check',
            'api/anonymous-session',
            'api/test-cors',
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
        //
    })->create();