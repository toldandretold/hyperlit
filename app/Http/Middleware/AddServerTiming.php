<?php

namespace App\Http\Middleware;

use App\Support\ServerTiming;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Attach the request's ServerTiming spans as a `Server-Timing` header.
 * Route-level middleware, applied ONLY to the page-load-critical routes
 * (/u/{username} and the database-to-indexeddb book payloads) — see
 * app/Support/ServerTiming.php. Inert unless SERVER_TIMING_ENABLED=true.
 */
class AddServerTiming
{
    public function __construct(private readonly ServerTiming $timing)
    {
    }

    public function handle(Request $request, Closure $next): Response
    {
        $this->timing->start('total');
        $response = $next($request);
        $this->timing->stop('total');

        $header = $this->timing->header();
        if ($header !== null) {
            $response->headers->set('Server-Timing', $header);
        }

        return $response;
    }
}
