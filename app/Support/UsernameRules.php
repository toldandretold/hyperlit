<?php

namespace App\Support;

use App\Rules\UniqueUsername;

/**
 * The ONE definition of what a username may be.
 *
 * There are two registration paths — the SPA's POST /api/register
 * (AuthController::register) and the no-JS fallback POST /register
 * (App\Actions\Fortify\CreateNewUser) — and they used to carry a
 * hand-duplicated copy of this rule block each. A laxer copy is a bypass:
 * the 2026-09-22 username squat could simply have moved to whichever path
 * had the weaker list, which is why CreateNewUser's docblock already said the
 * two must not diverge. Now they don't: both call rules().
 *
 * (resources/js/components/userContainer/validation.ts mirrors the SHAPE
 * rules client-side for instant feedback. It cannot check uniqueness or the
 * blocklists — the server owns those, and its 422 carries the message.)
 */
final class UsernameRules
{
    /**
     * Validation rules for the `name` field on account creation.
     *
     * @return array<int, mixed>
     */
    public static function rules(): array
    {
        return [
            'required',
            'string',
            'min:3',
            'max:30',
            'alpha_dash', // letters, numbers, hyphens, underscores — no spaces
            'regex:/^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$/', // cannot start/end with - or _

            // Case- AND space-insensitive uniqueness, on pgsql_admin.
            new UniqueUsername(),

            // A username is reachable at /{name} via the catch-all, so a name
            // matching a root route is shadowed by it and unreachable. Same
            // list book slugs use — config/reserved-routes.php, gated by
            // tests/Feature/Routing/ReservedRoutesTest.
            //
            // Compared on the URL key rather than Rule::notIn (which is
            // case-sensitive and let `Maintainer` straight through).
            function ($attribute, $value, $fail) {
                if (UsernameKey::isReserved((string) $value, config('reserved-routes'))) {
                    $fail('This username is reserved and cannot be used.');
                }
            },

            // Impersonation blocklist — SEPARATE list, different purpose
            // (config/reserved-usernames.php). Same key comparison.
            function ($attribute, $value, $fail) {
                if (UsernameKey::isReserved((string) $value, config('reserved-usernames'))) {
                    $fail('This username is reserved and cannot be used.');
                }
            },
        ];
    }

    /**
     * Custom messages for the shape rules above (the closures and
     * UniqueUsername supply their own).
     *
     * @return array<string, string>
     */
    public static function messages(): array
    {
        return [
            'name.alpha_dash' => 'Username can only contain letters, numbers, hyphens, and underscores.',
            'name.regex' => 'Username cannot start or end with - or _.',
            'name.min' => 'Username must be at least 3 characters.',
            'name.max' => 'Username must be 30 characters or less.',
        ];
    }
}
