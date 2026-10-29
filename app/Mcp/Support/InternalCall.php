<?php

namespace App\Mcp\Support;

use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response as SymfonyResponse;

/**
 * In-process controller invocation for MCP tools — the ONE place a crafted
 * Request is built, so the fragility of the pattern is contained and audited
 * here. This is the same technique UnifiedSyncController already uses to
 * batch the hyperlight/hypercite/footnote controllers (new Request +
 * setUserResolver + direct method call), standardized.
 *
 * Why not HTTP sub-requests: Route::dispatch would re-enter the full
 * middleware stack (CSRF, CORS, throttles, a second RLS context write) and
 * interacts badly with the one-DB-session RLS model. Why not services: most
 * desired behavior (notification writes, sub-book seeding, charData pruning)
 * lives in controller bodies today; extracting them is Phase-2 churn.
 *
 * The crafted Request carries its input in the QUERY bag (matching `new
 * Request($data)` in UnifiedSyncController) — Laravel's input() reads it
 * either way, and the read controllers (`$request->query('from')`) require
 * it. No cookies and no session: cookie-based fallbacks (anon_token) simply
 * don't fire, which is correct — the MCP caller is always a real user.
 *
 * RLS note: the Postgres session context was set once by the /mcp route's
 * middleware; everything called here runs on that same DB session, so RLS
 * behaves exactly as it would for the same user in the SPA.
 */
class InternalCall
{
    /**
     * Call a controller method with a crafted request.
     *
     * @param  class-string  $controller
     * @param  array<string, mixed>  $input
     * @param  array<int, mixed>  $routeArgs  positional args after the Request (e.g. a {bookId})
     * @return array{status: int, json: mixed}
     */
    public static function call(
        string $controller,
        string $method,
        array $input,
        ?Authenticatable $user,
        array $routeArgs = [],
        array $files = [],
        bool $prependRequest = true,
    ): array {
        $request = new Request($input, [], [], [], $files);
        $request->headers->set('Accept', 'application/json');
        $request->setUserResolver(fn () => $user);

        // Bind the request onto the container so controller methods that reach
        // for request() mid-body resolve the MCP caller even when the method's
        // own signature takes no Request (e.g. importProgress). Restore the
        // original afterward so nothing downstream sees the crafted request.
        $original = app()->bound('request') ? app('request') : null;
        app()->instance('request', $request);

        try {
            $controllerInstance = app($controller);
            $response = $prependRequest
                ? $controllerInstance->{$method}($request, ...$routeArgs)
                : $controllerInstance->{$method}(...$routeArgs);
        } finally {
            if ($original !== null) {
                app()->instance('request', $original);
            }
        }

        return static::decode($response);
    }

    /**
     * @return array{status: int, json: mixed}
     */
    private static function decode(mixed $response): array
    {
        if ($response instanceof JsonResponse) {
            return ['status' => $response->getStatusCode(), 'json' => $response->getData(true)];
        }

        if ($response instanceof SymfonyResponse) {
            $decoded = json_decode((string) $response->getContent(), true);

            return ['status' => $response->getStatusCode(), 'json' => $decoded];
        }

        return ['status' => 200, 'json' => $response];
    }
}
