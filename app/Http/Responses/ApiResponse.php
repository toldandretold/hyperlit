<?php

namespace App\Http\Responses;

use Illuminate\Contracts\Support\MessageBag;
use Illuminate\Http\JsonResponse;

/**
 * The standard JSON envelope for API responses (F5/F6).
 *
 * This is NOT a new shape — it's the de-facto convention the SPA already expects
 * (confirmed by surveying resources/js): there is no central fetch wrapper, so
 * callers key off the HTTP status (`!res.ok`) FIRST, then read a `success`
 * boolean, a `message` string, and `errors` ({field:[...]}) on validation. Domain
 * payloads stay under their OWN named keys (library, overrides, nodes…), NOT a
 * generic `data` wrapper — wrapping them would break the frontend.
 *
 *   ok(['library' => $row], 'Saved')  → 200 { success:true, library:{…}, message:'Saved' }
 *   validationError($errors)          → 422 { success:false, message:'Validation failed', errors:{…} }
 *   error('Forbidden', 403)           → 403 { success:false, message:'Forbidden' }
 *
 * Use this to bring deviating endpoints (bare {errors}, 400-for-validation,
 * masked-500s) onto the one shape the frontend already handles, without changing
 * what success payloads look like.
 */
final class ApiResponse
{
    /** Success. $payload is merged at the TOP level (named keys), not nested under `data`. */
    public static function ok(array $payload = [], ?string $message = null, int $status = 200): JsonResponse
    {
        $body = ['success' => true];
        if ($message !== null) {
            $body['message'] = $message;
        }

        return response()->json(array_merge($body, $payload), $status);
    }

    /** A non-validation error (auth, not-found, conflict, server). */
    public static function error(string $message, int $status = 400, array $extra = []): JsonResponse
    {
        return response()->json(array_merge(['success' => false, 'message' => $message], $extra), $status);
    }

    /** A 422 validation failure with field errors — the shape the SPA reads as `.errors`. */
    public static function validationError(MessageBag|array $errors, string $message = 'Validation failed'): JsonResponse
    {
        return response()->json([
            'success' => false,
            'message' => $message,
            'errors'  => $errors,
        ], 422);
    }
}
