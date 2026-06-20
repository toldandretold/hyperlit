<?php

namespace Tests\Support;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Seed RLS-protected fixtures (users, library rows, annotations) past Row-Level
 * Security so security/feature tests can set up state, while the assertions still
 * run RLS-ENFORCED through actingAs()+HTTP.
 *
 * Why this exists: a bare `User::factory()->create()` is rejected by the `users`
 * table — the INSERT policy is `WITH CHECK (true)`, but Eloquent's `INSERT …
 * RETURNING id` also triggers the SELECT policy `name = current_setting(
 * 'app.current_user')`, and during seeding no app.current_user is set. Same story
 * for `library`/`hyperlights` inserts. The fix the codebase already uses
 * (InteractsWithApi::apiUser / CanonicalSeedHelpers) is to seed through the
 * BYPASSRLS `pgsql_admin` connection. This trait centralises that so any test can
 * `$this->seedUser()` / `$this->seedBook()` and get a clean teardown.
 *
 * RefreshDatabase only transacts the default `pgsql` connection, so admin-seeded
 * rows COMMIT and must be removed explicitly — cleanupRlsFixtures() (call it from
 * an afterEach; Pest wires this in tests/Pest.php) deletes exactly the rows this
 * trait created, tracked by id/key, so it never touches real data.
 */
trait SeedsRlsFixtures
{
    /** @var int[] */
    protected array $rlsSeededUserIds = [];
    /** @var string[] */
    protected array $rlsSeededBooks = [];

    /**
     * Create a user via the BYPASSRLS admin connection and return it (NOT
     * authenticated — call actingAs() yourself, like the tests already do).
     * Accepts the same attribute array as User::factory()->create([...]).
     */
    protected function seedUser(array $attrs = []): User
    {
        $defaults = [
            'name'              => 'rls_test_' . Str::random(8),
            'email'             => 'rls_' . Str::random(10) . '@rlstest.local',
            'email_verified_at' => now(),
            'password'          => Hash::make('password'),
            'remember_token'    => Str::random(10),
            'user_token'        => Str::uuid()->toString(),
            'created_at'        => now(),
            'updated_at'        => now(),
        ];
        $data = array_merge($defaults, $attrs);

        $id = DB::connection('pgsql_admin')->table('users')->insertGetId($data);
        $this->rlsSeededUserIds[] = $id;

        return User::on('pgsql_admin')->findOrFail($id);
    }

    /**
     * Seed a `library` row via the admin connection. Takes the same attribute
     * array as PgLibrary::create([...]) (only `book` is required); idempotent
     * (ON CONFLICT DO NOTHING) so it also covers the firstOrCreate() call sites.
     */
    protected function seedLibrary(array $attrs): string
    {
        $book = $attrs['book'];
        $row = array_merge([
            'title'      => 'RLS Test Book',
            'visibility' => 'private',
            'raw_json'   => json_encode(['book' => $book]),
            'created_at' => now(),
            'updated_at' => now(),
        ], $attrs);

        DB::connection('pgsql_admin')->table('library')->insertOrIgnore($row);
        $this->rlsSeededBooks[] = $book;

        return $book;
    }

    /** Seed a `hyperlights` row via the admin connection (same attrs as PgHyperlight::create). */
    protected function seedHyperlight(array $attrs): void
    {
        $row = array_merge(['time_since' => time(), 'created_at' => now(), 'updated_at' => now()], $attrs);
        DB::connection('pgsql_admin')->table('hyperlights')->insertOrIgnore($row);
        if (isset($attrs['book'])) {
            $this->rlsSeededBooks[] = $attrs['book'];
        }
    }

    /** Seed a `nodes` row via the admin connection (same attrs as PgNode::create). */
    protected function seedNode(array $attrs): void
    {
        $row = array_merge(['chunk_id' => 0, 'created_at' => now(), 'updated_at' => now()], $attrs);
        DB::connection('pgsql_admin')->table('nodes')->insertOrIgnore($row);
        if (isset($attrs['book'])) {
            $this->rlsSeededBooks[] = $attrs['book'];
        }
    }

    /** Seed a `hypercites` row via the admin connection (same attrs as PgHypercite::create). */
    protected function seedHypercite(array $attrs): void
    {
        $row = array_merge(['time_since' => time(), 'created_at' => now(), 'updated_at' => now()], $attrs);
        DB::connection('pgsql_admin')->table('hypercites')->insertOrIgnore($row);
        if (isset($attrs['book'])) {
            $this->rlsSeededBooks[] = $attrs['book'];
        }
    }

    /**
     * Remove every row this trait seeded (admin-committed, so RefreshDatabase
     * won't roll them back). Scoped to tracked books/users — never touches real data.
     */
    protected function cleanupRlsFixtures(): void
    {
        $admin = DB::connection('pgsql_admin');

        if ($this->rlsSeededBooks) {
            $books = array_values(array_unique($this->rlsSeededBooks));
            foreach (['hyperlights', 'hypercites', 'nodes', 'library'] as $table) {
                try {
                    $admin->table($table)->whereIn('book', $books)->delete();
                } catch (\Throwable $e) {
                    // table absent in this schema state — ignore
                }
            }
            $this->rlsSeededBooks = [];
        }
        if ($this->rlsSeededUserIds) {
            $admin->table('users')->whereIn('id', $this->rlsSeededUserIds)->delete();
            $this->rlsSeededUserIds = [];
        }
    }
}
