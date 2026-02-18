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
 * The auth_lookup_user() function only returns: id, password, remember_token
 * - Cannot enumerate users (must know email)
 * - Cannot access other user data (email, name, etc. not returned)
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

        // Use forceFill to set ALL attributes including non-fillable ones like 'id'
        $user = new User();
        $user->forceFill((array) $result);
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

        // Use forceFill to set ALL attributes including non-fillable ones like 'id'
        $user = new User();
        $user->forceFill((array) $result);
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

        // Use the SECURITY DEFINER function to bypass RLS
        $result = DB::selectOne('SELECT * FROM auth_lookup_user(?)', [$email]);

        if (!$result) {
            return null;
        }

        // Fetch full user data using bypass function
        $fullUser = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$result->id]);

        if (!$fullUser) {
            return null;
        }

        // Use forceFill to set ALL attributes including non-fillable ones like 'id'
        // Note: forceFill triggers the 'hashed' cast, so if the DB has a plaintext
        // password, $user->password will be a proper bcrypt hash in memory — but
        // the DB still holds plaintext. Detect and fix that here via the admin connection.
        $user = new User();
        $user->forceFill((array) $fullUser);
        $user->exists = true;

        if (!Hash::isHashed($fullUser->password)) {
            DB::connection('pgsql_admin')
                ->table('users')
                ->where('id', $fullUser->id)
                ->update(['password' => $user->password]);
        }

        return $user;
    }
}
