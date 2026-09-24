<?php

namespace App\Rules;

use App\Support\UsernameKey;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Support\Facades\DB;

/**
 * Username uniqueness, compared on the URL key (case- and space-insensitive).
 *
 * Replaces `unique:pgsql_admin.users,name`, which compared EXACTLY — so
 * `James` and `james` were both registerable and then fought over `/u/james`.
 * Since the 2026-09-22 squat (see tests/Feature/Security/ReservedUsernamesTest)
 * that is also an impersonation vector: the blocklist stops `marx`, a plain
 * case-sensitive unique check never stopped `Marx`.
 *
 * Runs on `pgsql_admin` deliberately. `hyperlit_app` is RLS-subject and
 * `users_select_policy` limits SELECT to your own row, so this check on the
 * default connection would see nothing and pass wrongly for every name.
 *
 * This is the friendly half of the guard; the authority is the unique index
 * `users_name_url_unique`, which also closes the TOCTOU race between this
 * check and the INSERT (both registration paths catch 23505).
 */
class UniqueUsername implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value) || $value === '') {
            return; // `required`/`string` own this case
        }

        $exists = DB::connection('pgsql_admin')->table('users')
            ->whereRaw("lower(replace(name, ' ', '')) = ?", [UsernameKey::for($value)])
            ->exists();

        if ($exists) {
            $fail('This username is already taken. Usernames are not case-sensitive.');
        }
    }
}
