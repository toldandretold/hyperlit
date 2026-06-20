<?php

namespace Tests\Support;

use App\Models\PgHypercite;
use App\Models\PgHyperlight;
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

        // Tests that pass a FIXED email/name (e.g. 'attacker@test.com') collide with leftover rows
        // from a prior run (users_email_unique → 23505). Clear any residue for this email/name first.
        DB::connection('pgsql_admin')->table('users')
            ->where('email', $data['email'])->orWhere('name', $data['name'])->delete();

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

        // updateOrInsert (NOT insertOrIgnore): a leftover row for this fixed book id from a prior
        // run (owned by a DIFFERENT random rls_test_* user) would otherwise be kept, so ownership
        // wouldn't match the current test → spurious 403s in the cross-tenant suite. Overwrite it.
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(['book' => $book], $row);
        $this->rlsSeededBooks[] = $book;

        return $book;
    }

    /**
     * Seed a `hyperlights` row (same attrs as PgHyperlight::create). Goes through the Eloquent
     * MODEL on the admin connection (not a raw table insert) so the `'array'` casts apply —
     * `node_id`/`charData`/`preview_nodes` are jsonb columns, and a raw string/array would hit
     * them as invalid JSON (SQLSTATE 22P02). `::on('pgsql_admin')` keeps it BYPASSRLS.
     */
    protected function seedHyperlight(array $attrs): void
    {
        // raw_json is NOT NULL on hyperlights AND is NOT cast on PgHyperlight (custom accessor —
        // see the model note), so it must be json_encode()'d in write paths.
        $row = array_merge(['time_since' => time(), 'raw_json' => json_encode($attrs), 'created_at' => now(), 'updated_at' => now()], $attrs);
        // Drop any leftover row for this key first (prior-run residue would make create() throw a
        // unique violation), then create through the model so the jsonb casts apply.
        if (isset($attrs['book'], $attrs['hyperlight_id'])) {
            DB::connection('pgsql_admin')->table('hyperlights')
                ->where('book', $attrs['book'])->where('hyperlight_id', $attrs['hyperlight_id'])->delete();
        }
        PgHyperlight::on('pgsql_admin')->create($row);
        if (isset($attrs['book'])) {
            $this->rlsSeededBooks[] = $attrs['book'];
        }
    }

    /** Seed a `nodes` row via the admin connection (same attrs as PgNode::create). */
    protected function seedNode(array $attrs): void
    {
        // raw_json is NOT NULL on nodes; this is a RAW insert (no model casts), so json-encode it.
        $row = array_merge(['chunk_id' => 0, 'raw_json' => json_encode($attrs), 'created_at' => now(), 'updated_at' => now()], $attrs);
        // updateOrInsert by the [book, startLine] primary key so leftover residue is overwritten.
        if (isset($attrs['book'], $attrs['startLine'])) {
            DB::connection('pgsql_admin')->table('nodes')
                ->updateOrInsert(['book' => $attrs['book'], 'startLine' => $attrs['startLine']], $row);
        } else {
            DB::connection('pgsql_admin')->table('nodes')->insertOrIgnore($row);
        }
        if (isset($attrs['book'])) {
            $this->rlsSeededBooks[] = $attrs['book'];
        }
    }

    /** Seed a `hypercites` row via the admin MODEL (casts apply for jsonb node_id/charData/citedIN). */
    protected function seedHypercite(array $attrs): void
    {
        $row = array_merge(['time_since' => time(), 'raw_json' => $attrs, 'created_at' => now(), 'updated_at' => now()], $attrs);
        if (isset($attrs['book'], $attrs['hyperciteId'])) {
            DB::connection('pgsql_admin')->table('hypercites')
                ->where('book', $attrs['book'])->where('hyperciteId', $attrs['hyperciteId'])->delete();
        }
        PgHypercite::on('pgsql_admin')->create($row);
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

        // RefreshDatabase rolls back the transaction but does NOT reset Postgres SESSION config
        // vars. SetDatabaseSessionContext sets app.current_user/token via set_config(..., false)
        // (session-level) on each request, so the RLS context LEAKS into the next test on the
        // reused connection. Clear it so cross-tenant tests start from a clean (anonymous) context.
        foreach (['app.current_user', 'app.current_token', 'app.session_id'] as $var) {
            try {
                DB::statement("SELECT set_config(?, '', false)", [$var]);
            } catch (\Throwable $e) {
                // ignore — best-effort reset
            }
        }
    }
}
