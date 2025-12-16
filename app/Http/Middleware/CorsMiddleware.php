<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class CorsMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        // FIRST, handle the preflight (OPTIONS) request
        if ($request->isMethod('OPTIONS')) {
            return $this->handleOptions($request);
        }

        // THEN, for all other requests (GET, POST, etc.), run the request
        // and add the CORS headers to the response.
        $response = $next($request);
        return $this->addCorsHeaders($response, $request);
    }

    /**
     * Handle the preflight OPTIONS request.
     */
    private function handleOptions(Request $request): Response
    {
        $allowedOrigin = $this->getAllowedOrigin($request);

        // 🔒 SECURITY: If origin is not allowed, return 403
        if ($allowedOrigin === null) {
            return response('Origin not allowed', 403);
        }

        return response('', 200)
            ->header('Access-Control-Allow-Origin', $allowedOrigin)
            ->header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            ->header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-CSRF-TOKEN')
            ->header('Access-Control-Allow-Credentials', 'true');
    }

    /**
     * Add the CORS headers to an existing response.
     */
    private function addCorsHeaders(Response $response, Request $request): Response
    {
        $allowedOrigin = $this->getAllowedOrigin($request);

        // 🔒 SECURITY: Only add CORS headers if origin is allowed
        if ($allowedOrigin !== null) {
            $response->headers->set('Access-Control-Allow-Origin', $allowedOrigin);
            $response->headers->set('Access-Control-Allow-Credentials', 'true');
        }
        return $response;
    }

    /**
     * Determine the allowed origin.
     * 🔒 SECURITY: Only allow explicitly whitelisted origins, reject unknown origins
     */
    private function getAllowedOrigin(Request $request): ?string
    {
        $origin = $request->header('Origin');

        // 🔒 SECURITY: Use environment-based configuration for production flexibility
        $allowedOrigins = array_filter([
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
        ]);

        if ($origin && in_array($origin, $allowedOrigins, true)) {
            return $origin;
        }

        // 🔒 SECURITY: Return null for unknown origins instead of fallback
        // This prevents cross-site attacks from arbitrary domains
        return null;
    }
}