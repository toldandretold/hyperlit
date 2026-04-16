<?php

namespace App\Auth;

use App\Models\User;
use Illuminate\Auth\EloquentUserProvider;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * Custom user provider that uses a SECURITY DEFINER function for authentication.
 *
 * This bypasses Row Level Security during login lookups while maintaining
 * RLS protection for all other user table operations.
 *
 * Uses auth_lookup_user_by_email() to get the user id from their email,
 * then auth_lookup_user_by_id() to fetch the full user record for password validation.
 * - Cannot enumerate users (must know email)
 * - auth_lookup_user_by_email returns only (id, email) — no password hash
 * - Read-only (cannot modify users)
 */
class RlsUserProvider extends EloquentUserProvider
{
    /**
     * Retrieve a user by their unique identifier (ID).
     *
     * This is called on every request to load the authenticated user from session.
     * Must use bypass function because RLS requires knowing the user first.
     */
    public function retrieveById($identifier): ?Authenticatable
    {
        $result = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$identifier]);

        if (!$result) {
            return null;
        }

        // Use setRawAttributes (not forceFill) so JSON/cast columns like
        // 'preferences' aren't double-encoded by the setter cast.
        $user = new User();
        $user->setRawAttributes((array) $result, true);
        $user->exists = true;

        return $user;
    }

    /**
     * Retrieve a user by their unique identifier and "remember me" token.
     *
     * Uses the bypass function since user may not be authenticated yet.
     */
    public function retrieveByToken($identifier, $token): ?Authenticatable
    {
        $result = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$identifier]);

        if (!$result || !hash_equals($result->remember_token ?? '', $token ?? '')) {
            return null;
        }

        // Use setRawAttributes (not forceFill) so JSON/cast columns like
        // 'preferences' aren't double-encoded by the setter cast.
        $user = new User();
        $user->setRawAttributes((array) $result, true);
        $user->exists = true;

        return $user;
    }

    /**
     * Retrieve a user by the given credentials.
     *
     * This is called during login - uses bypass function to avoid RLS.
     */
    public function retrieveByCredentials(array $credentials): ?Authenticatable
    {
        // Don't allow retrieval by password
        $credentials = array_filter(
            $credentials,
            fn ($key) => !str_contains($key, 'password'),
            ARRAY_FILTER_USE_KEY
        );

        if (empty($credentials)) {
            return null;
        }

        // Get email from credentials
        $email = $credentials['email'] ?? null;

        if (!$email) {
            return null;
        }

        // Use the SECURITY DEFINER function to bypass RLS (returns only id + email)
        $result = DB::selectOne('SELECT * FROM auth_lookup_user_by_email(?)', [$email]);

        if (!$result) {
            return null;
        }

        // Fetch full user data using bypass function
        $fullUser = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$result->id]);

        if (!$fullUser) {
            return null;
        }

        // Use setRawAttributes (not forceFill) so JSON/cast columns like
        // 'preferences' aren't double-encoded by the setter cast.
        // Note: the 'hashed' cast on password only triggers via forceFill/setAttribute,
        // so we check for unhashed passwords manually below.
        $user = new User();
        $user->setRawAttributes((array) $fullUser, true);
        $user->exists = true;

        if (!Hash::isHashed($fullUser->password)) {
            $hashed = Hash::make($fullUser->password);
            $user->setRawAttributes(
                array_merge($user->getAttributes(), ['password' => $hashed]),
                true
            );
            DB::connection('pgsql_admin')
                ->table('users')
                ->where('id', $fullUser->id)
                ->update(['password' => $hashed]);
        }

        return $user;
    }
}
