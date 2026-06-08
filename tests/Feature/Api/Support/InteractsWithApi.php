<?php

namespace Tests\Feature\Api\Support;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * Shared helpers for the API endpoint suite.
 *
 * Bound to every test under tests/Feature/Api/ via `uses()` in tests/Pest.php,
 * so inside a test closure you can call $this->loginUser(), $this->makeBook(),
 * $this->anonSession(), $this->assertApiError().
 *
 * Why these exist: the RLS model means a test can't just `User::factory()->create()`
 * — the `users` table blocks INSERT from the app's `pgsql` role, so users (and
 * any pre-seeded `library` rows) must be created via the BYPASSRLS `pgsql_admin`
 * connection. These helpers centralise that ceremony so each test file isn't 40
 * lines of boilerplate. Mirrors the inline helpers in
 * tests/Feature/Security/UserTokenRlsTest.php and tests/Feature/Import/ImportPipelineTest.php.
 */
trait InteractsWithApi
{
    /**
     * Create a user via the admin (BYPASSRLS) connection and return it.
     * Does NOT authenticate — use loginUser() for that.
     */
    protected function apiUser(array $attrs = []): User
    {
        $defaults = [
            'name'              => 'api_test_' . Str::random(8),
            'email'             => 'api_' . Str::random(8) . '@test.local',
            'email_verified_at' => now(),
            'password'          => Hash::make('password'),
            'remember_token'    => Str::random(10),
            'user_token'        => Str::uuid()->toString(),
            'created_at'        => now(),
            'updated_at'        => now(),
        ];
        $data = array_merge($defaults, $attrs);

        DB::connection('pgsql_admin')->table('users')->insert($data);

        return User::on('pgsql_admin')->where('email', $data['email'])->firstOrFail();
    }

    /**
     * Create a user and authenticate the test session as them.
     * Covers routes guarded by auth:sanctum and the `author` middleware
     * (a logged-in user satisfies both). Returns the user.
     */
    protected function loginUser(array $attrs = []): User
    {
        $user = $this->apiUser($attrs);
        $this->actingAs($user);

        return $user;
    }

    /**
     * Establish an anonymous session by hitting the real endpoint, the way the
     * SPA does. Returns ['token' => string, 'response' => TestResponse]. The
     * anon_token cookie is set on the test's cookie jar, so subsequent
     * $this->postJson(...) calls in the same test are treated as that anon author.
     */
    protected function anonSession(): array
    {
        $response = $this->postJson('/api/anonymous-session');
        $response->assertStatus(200);

        return [
            'token'    => $response->json('token'),
            'response' => $response,
        ];
    }

    /**
     * Insert a minimal `library` row and return its bookId. Pass a User to make
     * it an owned (logged-in) book — RLS keys off a JOIN to users, so
     * creator_token stays NULL. Pass a token string for an anonymous book —
     * creator is NULL, creator_token holds the token.
     *
     * `via` controls the connection, which matters because of how the row is
     * locked during the test:
     *   - 'admin' (default): committed via pgsql_admin (BYPASSRLS). Visible to
     *     controllers that read the library through pgsql_admin (e.g. citation
     *     scanner). Use when the controller does NOT write the row through the
     *     default connection.
     *   - 'app': inserted through the DEFAULT (pgsql) connection under the
     *     owner's RLS context, so it lives inside the test's RefreshDatabase
     *     transaction. REQUIRED when the controller-under-test mutates the row
     *     via the default connection (e.g. reconvert's clearBookContent/save):
     *     an admin-committed row would be lock-held by that write at teardown and
     *     the afterEach pgsql_admin cleanup would deadlock against it. App-seeded
     *     rows roll back automatically — no cleanup, no cross-connection lock.
     */
    protected function makeBook(User|string|null $owner = null, array $attrs = []): string
    {
        $via  = $attrs['via'] ?? 'admin';
        $book = $attrs['book'] ?? 'apitest_' . Str::random(12);

        $row = [
            'book'        => $book,
            'title'       => $attrs['title'] ?? 'API Test Book',
            'visibility'  => $attrs['visibility'] ?? 'private',
            'creator'     => null,
            'creator_token' => null,
            'created_at'  => now(),
            'updated_at'  => now(),
        ];

        if ($owner instanceof User) {
            $row['creator'] = $owner->name;        // logged-in: RLS JOINs to users
        } elseif (is_string($owner)) {
            $row['creator_token'] = $owner;        // anonymous: token stored inline
        }

        $row = array_merge($row, array_diff_key($attrs, array_flip(['book', 'title', 'visibility', 'via'])));
        $row['raw_json'] = $attrs['raw_json'] ?? json_encode(['book' => $book]);

        if ($via === 'app') {
            // Seed under the owner's RLS context so the INSERT WITH CHECK passes.
            $user  = $owner instanceof User ? $owner->name : '';
            $token = $owner instanceof User ? $owner->user_token : (is_string($owner) ? $owner : '');
            DB::statement("SELECT set_config('app.current_user', ?, false)", [$user]);
            DB::statement("SELECT set_config('app.current_token', ?, false)", [$token]);
            DB::table('library')->insert($row);
        } else {
            DB::connection('pgsql_admin')->table('library')->insert($row);
        }

        return $book;
    }

    /**
     * Remove fixtures seeded via the admin (BYPASSRLS) connection.
     *
     * RefreshDatabase only transacts the default `pgsql` connection, so rows
     * written via `pgsql_admin` (users, library, and the job-tracking tables
     * keyed off them) COMMIT and would otherwise leak between tests. Call this
     * from an afterEach in each Api test file. Scoped to the suite's prefixes so
     * it never touches real data. Random ids mean leaked rows don't collide, but
     * cleaning up keeps the test DB from accumulating cruft.
     */
    protected function cleanupApiFixtures(): void
    {
        $admin = DB::connection('pgsql_admin');
        // Job/scan rows reference books by id; clear them before the library rows.
        foreach (['citation_scans', 'citation_pipelines'] as $table) {
            try {
                $admin->table($table)->where('book', 'like', 'apitest\_%')->delete();
            } catch (\Throwable $e) {
                // table may not exist in every schema state — ignore
            }
        }
        // Rows keyed by the random test username (api_test_…) — created via
        // pgsql_admin by controllers like Shelf/Vibes/Prefs, so not rolled back.
        foreach (['shelves', 'shelf_items', 'shelf_pins', 'vibes'] as $table) {
            try {
                $admin->table($table)->where('creator', 'like', 'api\_test\_%')->delete();
            } catch (\Throwable $e) {
                // column/table absent in this schema state — ignore
            }
        }
        $admin->table('library')->where('book', 'like', 'apitest\_%')->delete();
        $admin->table('users')->where('email', 'like', 'api\_%@test.local')->delete();
    }

    /**
     * Assert a response is a client/auth error with the given status.
     *
     * Deliberately tolerant: today's controllers return several error shapes
     * ({success:false,message}, {error,reason}, bare {message}, or Laravel's
     * 422 {message,errors}). This asserts the *status* (the contract the SPA
     * branches on) without locking in any one body shape — standardising that
     * shape is a deferred restructure item, see docs/api-restructure-findings.md.
     */
    protected function assertApiError(TestResponse $response, int $status): TestResponse
    {
        $response->assertStatus($status);

        return $response;
    }
}
