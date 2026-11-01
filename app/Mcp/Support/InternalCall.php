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
            $args = static::assembleArgs($controllerInstance, $method, $request, $routeArgs, $prependRequest);
            $response = $controllerInstance->{$method}(...$args);
        } finally {
            if ($original !== null) {
                app()->instance('request', $original);
            }
        }

        return static::decode($response);
    }

    /**
     * Build the positional argument list for a controller method, placing the
     * crafted Request wherever its signature expects it (first, last, or not at
     * all) and filling the remaining positional params from $routeArgs IN ORDER.
     * Controllers vary: handle(Request), importProgress(string $bookId),
     * complete(string $id, Request $request), getBookDataBatch(Request, string
     * $bookId) — reflection gets them all right, so callers don't have to track
     * the ordering. $prependRequest is honoured only as a fallback when
     * reflection can't see a Request-typed parameter.
     *
     * @param  array<int, mixed>  $routeArgs
     * @return array<int, mixed>
     */
    private static function assembleArgs(object $controller, string $method, Request $request, array $routeArgs, bool $prependRequest): array
    {
        try {
            $params = (new \ReflectionMethod($controller, $method))->getParameters();
        } catch (\ReflectionException) {
            return $prependRequest ? [$request, ...$routeArgs] : $routeArgs;
        }

        // Reflection is AUTHORITATIVE: place the Request only where a
        // Request-typed parameter actually is, and fill the rest from
        // routeArgs IN ORDER. A method with no Request param (importProgress,
        // pipelineRunning, resumePipeline) gets NONE — never a stringified
        // Request in its id slot. ($prependRequest is honoured only in the
        // ReflectionException catch above, where we can't inspect the method.)
        $args = [];
        $queue = $routeArgs;
        foreach ($params as $param) {
            $type = $param->getType();
            $typeName = $type instanceof \ReflectionNamedType ? $type->getName() : null;
            $isRequest = $typeName !== null && is_a($typeName, Request::class, true);

            if ($isRequest) {
                $args[] = $request;
            } elseif ($queue !== []) {
                $args[] = array_shift($queue);
            } else {
                break; // remaining params are optional / have defaults
            }
        }

        return $args;
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
