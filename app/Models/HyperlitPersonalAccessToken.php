<?php

namespace App\Models;

use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\PersonalAccessToken as SanctumPersonalAccessToken;

/**
 * Sanctum token model adapted to this app's RLS reality (registered via
 * Sanctum::usePersonalAccessTokenModel in AppServiceProvider).
 *
 * Two departures from stock Sanctum, both mirroring RlsUserProvider:
 *
 * 1. `tokenable` cannot be a plain morphTo: at bearer-auth time
 *    app.current_user is not set yet, so the users SELECT policy hides the
 *    row and stock Sanctum would 401 every token. The accessor resolves the
 *    user through auth_lookup_user_by_id() — the same SECURITY DEFINER
 *    function the session login path uses — and hydrates a default-connection
 *    User, so nothing downstream of auth ever rides a BYPASSRLS connection.
 *
 * 2. The connection is pinned to the default. A HasMany/MorphMany child
 *    inherits its PARENT model's connection, and several code paths (tests
 *    seeding via SeedsRlsFixtures, admin tooling) hold User instances bound
 *    to pgsql_admin — createToken() there would silently write outside
 *    RefreshDatabase's transaction. personal_access_tokens is deliberately
 *    not RLS-restricted, so the default connection is always sufficient.
 */
class HyperlitPersonalAccessToken extends SanctumPersonalAccessToken
{
    /** Eloquent derives the table from the class name — keep Sanctum's. */
    protected $table = 'personal_access_tokens';

    public function getConnectionName()
    {
        return config('database.default');
    }

    public function getTokenableAttribute(): ?User
    {
        if ($this->relationLoaded('tokenable')) {
            return $this->getRelation('tokenable');
        }

        $user = null;

        if ($this->tokenable_id && is_a($this->tokenable_type, User::class, true)) {
            $row = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$this->tokenable_id]);

            if ($row) {
                $user = new User();
                // setRawAttributes (not forceFill) so JSON/cast columns like
                // 'preferences' aren't double-encoded — same as RlsUserProvider.
                $user->setRawAttributes((array) $row, true);
                $user->exists = true;
            }
        }

        $this->setRelation('tokenable', $user);

        return $user;
    }
}
