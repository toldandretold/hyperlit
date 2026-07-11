<?php

namespace App\Actions\Fortify;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Laravel\Fortify\Contracts\CreatesNewUsers;

/**
 * Fortify web registration (the no-JS fallback for the SPA register form,
 * whose action="/register"; the JS path posts /api/register instead).
 *
 * Mirrors AuthController::register: the same username rules (the two paths
 * must not diverge — a laxer fallback would let names bypass the SPA rules),
 * uniqueness checked against pgsql_admin (RLS hides other users' rows from
 * the default connection, so a default-connection unique check passes
 * wrongly), and creation through the admin connection (under RLS a default-
 * connection INSERT…RETURNING on users always fails: the RETURNING triggers
 * the SELECT policy, which requires app.current_user to already match).
 */
class CreateNewUser implements CreatesNewUsers
{
    use PasswordValidationRules;

    /**
     * Validate and create a newly registered user.
     *
     * @param  array<string, string>  $input
     */
    public function create(array $input): User
    {
        Validator::make($input, [
            'name' => [
                'required',
                'string',
                'min:3',
                'max:30',
                'unique:pgsql_admin.users,name',
                'alpha_dash',
                'regex:/^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$/',
            ],
            'email' => [
                'required',
                'string',
                'email',
                'max:255',
                'unique:pgsql_admin.users,email',
            ],
            'password' => $this->passwordRules(),
        ], [
            'name.alpha_dash' => 'Username can only contain letters, numbers, hyphens, and underscores.',
            'name.regex' => 'Username cannot start or end with - or _.',
        ])->validate();

        $userId = DB::connection('pgsql_admin')->table('users')->insertGetId([
            'name' => $input['name'],
            'email' => $input['email'],
            'password' => Hash::make($input['password']),
            'user_token' => Str::uuid()->toString(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Read the fresh row back via admin — the caller (Fortify) logs the
        // user in before any RLS session context exists on the default conn.
        return User::on('pgsql_admin')->findOrFail($userId);
    }
}
