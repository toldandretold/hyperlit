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
        return response('', 200)
            ->header('Access-Control-Allow-Origin', $this->getAllowedOrigin($request))
            ->header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            ->header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-CSRF-TOKEN')
            ->header('Access-Control-Allow-Credentials', 'true');
    }

    /**
     * Add the CORS headers to an existing response.
     */
    private function addCorsHeaders(Response $response, Request $request): Response
    {
        $response->headers->set('Access-Control-Allow-Origin', $this->getAllowedOrigin($request));
        $response->headers->set('Access-Control-Allow-Credentials', 'true');
        return $response;
    }

    /**
     * Determine the allowed origin.
     */
    private function getAllowedOrigin(Request $request): string
    {
        $origin = $request->header('Origin');
        $allowedOrigins = [
            'http://127.0.0.1:8000',
            'http://localhost:8000',
            'http://192.168.1.169:5173',
            'http://localhost:5173',
            'http://libzen.com',
            'http://libzen.io,',
            'http://hyperlit.io'
        ];

        if (in_array($origin, $allowedOrigins)) {
            return $origin;
        }

        // Fallback for safety
        return 'http://127.0.0.1:8000';
    }
}