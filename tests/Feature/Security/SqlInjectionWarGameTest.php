<?php

/**
 * COMPREHENSIVE SQL INJECTION WAR-GAME TESTS
 *
 * Premise: Attacker has achieved SQL injection capability.
 * Goal: Verify RLS prevents them from accessing other users' data.
 *
 * These tests simulate an attacker who can execute arbitrary SQL
 * but cannot bypass PostgreSQL's RLS policies.
 *
 * Focus: Protecting logged-in users (anonymous user exposure is accepted risk).
 *
 * Test naming convention:
 * - WAR GAME A: Token extraction attacks
 * - WAR GAME B: Session manipulation attacks
 * - WAR GAME C: Data exfiltration attacks
 * - WAR GAME D: Data modification attacks
 * - WAR GAME E: RLS bypass attempts
 * - WAR GAME F: SECURITY DEFINER function abuse
 */

use Illuminate\Support\Str;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * Helper to create a user bypassing RLS via admin connection
 */
function createWarGameUser(array $attributes = []): object
{
    $defaults = [
        'name' => 'wartest_' . Str::random(8),
        'email' => Str::random(8) . '@wartest.com',
        'password' => Hash::make('password'),
        'user_token' => Str::uuid()->toString(),
        'created_at' => now(),
        'updated_at' => now(),
    ];

    $data = array_merge($defaults, $attributes);

    DB::connection('pgsql_admin')->table('users')->insert($data);

    $user = DB::connection('pgsql_admin')
        ->table('users')
        ->where('email', $data['email'])
        ->first();

    return $user;
}

/**
 * Helper to create library entry via admin connection
 */
function createWarGameLibrary(array $data): void
{
    $defaults = [
        'created_at' => now(),
        'updated_at' => now(),
        'raw_json' => json_encode($data),
    ];
    DB::connection('pgsql_admin')->table('library')->insert(array_merge($defaults, $data));
}

/**
 * Helper to create hyperlight entry via admin connection
 */
function createWarGameHyperlight(array $data): void
{
    $defaults = [
        'created_at' => now(),
        'updated_at' => now(),
        'node_id' => json_encode(['test-node-1']),
        'charData' => json_encode(['test-node-1' => ['charStart' => 0, 'charEnd' => 10]]),
        'raw_json' => json_encode($data),
    ];
    DB::connection('pgsql_admin')->table('hyperlights')->insert(array_merge($defaults, $data));
}

/**
 * Helper to create hypercite entry via admin connection
 */
function createWarGameHypercite(array $data): void
{
    $defaults = [
        'created_at' => now(),
        'updated_at' => now(),
        'node_id' => json_encode(['test-node-1']),
        'charData' => json_encode(['test-node-1' => ['charStart' => 0, 'charEnd' => 10]]),
        'citedIN' => json_encode([]),
        'raw_json' => json_encode($data),
    ];
    DB::connection('pgsql_admin')->table('hypercites')->insert(array_merge($defaults, $data));
}

/**
 * Helper to set attacker session context (simulates SQL injection scenario)
 */
function setAttackerSession(string $username = '', string $token = ''): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$username]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$token]);
}

/**
 * Cleanup test data via admin connection
 */
function cleanupWarGameData(): void
{
    DB::connection('pgsql_admin')->table('nodes')->where('book', 'like', 'wartest-%')->delete();
    DB::connection('pgsql_admin')->table('hyperlights')->where('book', 'like', 'wartest-%')->delete();
    DB::connection('pgsql_admin')->table('hypercites')->where('book', 'like', 'wartest-%')->delete();
    DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'wartest-%')->delete();
    DB::connection('pgsql_admin')->table('users')->where('email', 'like', '%@wartest.com')->delete();
}

beforeEach(fn() => cleanupWarGameData());
afterEach(fn() => cleanupWarGameData());

// ==========================================
// SECTION A: TOKEN EXTRACTION ATTACKS
// ==========================================

test('WAR GAME A1: attacker cannot SELECT user_token from users table (RLS blocks)', function () {
    // Setup: Create victim with known username
    $victim = createWarGameUser([
        'name' => 'victim_a1',
        'email' => 'victim_a1@wartest.com',
    ]);

    // Attack: Set app.current_user = 'victim', but NO valid token
    setAttackerSession('victim_a1', '');

    // Attempt to read user_token
    $result = DB::select("SELECT user_token FROM users WHERE name = 'victim_a1'");

    // RLS MUST block - attacker cannot read without valid token
    expect($result)->toBeEmpty('SECURITY BREACH: Attacker read user_token with username only!');
});

test('WAR GAME A2: attacker cannot SELECT user_token even with wrong token', function () {
    $victim = createWarGameUser([
        'name' => 'victim_a2',
        'email' => 'victim_a2@wartest.com',
    ]);

    // Attack: Correct username, wrong token
    setAttackerSession('victim_a2', Str::uuid()->toString());

    $result = DB::select("SELECT user_token FROM users WHERE name = 'victim_a2'");

    expect($result)->toBeEmpty('SECURITY BREACH: Attacker read user_token with wrong token!');
});

test('WAR GAME A3: attacker cannot extract token via auth_lookup_user_by_id function', function () {
    $victim = createWarGameUser([
        'name' => 'victim_a3',
        'email' => 'victim_a3@wartest.com',
    ]);

    // Attack: Call SECURITY DEFINER function with victim's ID
    setAttackerSession('', ''); // No valid session

    $result = DB::select("SELECT * FROM auth_lookup_user_by_id(?)", [$victim->id]);

    // Function should return data but NOT include user_token column
    expect($result)->toHaveCount(1);

    // Get column names from result
    $columns = array_keys((array) $result[0]);

    expect($columns)->not->toContain('user_token', 'SECURITY BREACH: auth_lookup_user_by_id returns user_token!');
    expect($columns)->not->toContain('email', 'SECURITY BREACH: auth_lookup_user_by_id returns email!');
});

test('WAR GAME A4: attacker cannot use subquery to bypass RLS and extract token', function () {
    $victim = createWarGameUser([
        'name' => 'victim_a4',
        'email' => 'victim_a4@wartest.com',
    ]);

    // Create a public book for the victim (so we can query library table)
    createWarGameLibrary([
        'book' => 'wartest-a4-public',
        'title' => 'Public Book',
        'creator' => 'victim_a4',
        'creator_token' => null,
        'visibility' => 'public',
    ]);

    // Attack: Try to use subquery to access users table from library context
    setAttackerSession('', ''); // Attacker has no valid session

    // Attempt subquery attack - try to extract user info through a subquery
    // This simulates what an attacker might try via SQL injection
    $result = DB::select("
        SELECT l.book,
               (SELECT user_token FROM users WHERE name = l.creator LIMIT 1) as stolen_token
        FROM library l
        WHERE l.book = 'wartest-a4-public'
    ");

    // The subquery should return NULL because RLS on users table blocks it
    expect($result)->toHaveCount(1);
    expect($result[0]->stolen_token)->toBeNull('SECURITY BREACH: Subquery extracted user_token!');
});

test('WAR GAME A5: attacker cannot extract token via UNION on users table', function () {
    $victim = createWarGameUser([
        'name' => 'victim_a5',
        'email' => 'victim_a5@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-a5-public',
        'title' => 'Public',
        'creator' => 'victim_a5',
        'creator_token' => null,
        'visibility' => 'public',
    ]);

    setAttackerSession('', '');

    // Attack: Try UNION to access users table
    // Simulates: SELECT title FROM library UNION SELECT user_token FROM users
    $libraryResult = DB::select("SELECT title FROM library WHERE book = 'wartest-a5-public'");
    $usersResult = DB::select("SELECT user_token::text as title FROM users WHERE name = 'victim_a5'");

    // Library query should work (public content)
    expect($libraryResult)->toHaveCount(1);
    // Users query should be blocked by RLS
    expect($usersResult)->toBeEmpty('SECURITY BREACH: UNION-style query extracted user_token!');
});

test('WAR GAME A6: attacker cannot read ANY columns from users table without proper auth', function () {
    $victim = createWarGameUser([
        'name' => 'victim_a6',
        'email' => 'victim_a6@wartest.com',
    ]);

    setAttackerSession('', '');

    // Try to read any data from users table
    $result = DB::select("SELECT * FROM users WHERE name = 'victim_a6'");

    expect($result)->toBeEmpty('SECURITY BREACH: Attacker read user row without auth!');
});

// ==========================================
// SECTION B: SESSION MANIPULATION ATTACKS
// ==========================================

test('WAR GAME B1: set_config in SQL does not grant access to other user data', function () {
    $victim = createWarGameUser([
        'name' => 'victim_b1',
        'email' => 'victim_b1@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-b1-private',
        'title' => 'Private Book',
        'creator' => 'victim_b1',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Start with no session
    setAttackerSession('', '');

    // Attack: Try to inject set_config to grant ourselves victim's access
    // This simulates what would happen if SQL injection allowed running set_config
    DB::statement("SELECT set_config('app.current_user', 'victim_b1', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)"); // We don't know the token

    // Even with username set, we can't access private content without correct token
    $result = DB::select("SELECT * FROM library WHERE book = 'wartest-b1-private'");

    expect($result)->toBeEmpty('SECURITY BREACH: set_config username-only granted access!');
});

test('WAR GAME B2: set_config with guessed token does not work', function () {
    $victim = createWarGameUser([
        'name' => 'victim_b2',
        'email' => 'victim_b2@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-b2-private',
        'title' => 'Private',
        'creator' => 'victim_b2',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Attack: Try set_config with a random UUID (guessing the token)
    $guessedToken = Str::uuid()->toString();
    DB::statement("SELECT set_config('app.current_user', 'victim_b2', false)");
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$guessedToken]);

    $result = DB::select("SELECT * FROM library WHERE book = 'wartest-b2-private'");

    expect($result)->toBeEmpty('SECURITY BREACH: Guessed token granted access!');
});

test('WAR GAME B3: empty string token does NOT match NULL creator_token', function () {
    $victim = createWarGameUser([
        'name' => 'victim_b3',
        'email' => 'victim_b3@wartest.com',
    ]);

    // Logged-in user content: creator_token is NULL
    createWarGameLibrary([
        'book' => 'wartest-b3-private',
        'title' => 'Private',
        'creator' => 'victim_b3',
        'creator_token' => null, // NULL for logged-in users
        'visibility' => 'private',
    ]);

    // Attack: Set username but empty token - empty string should NOT match NULL
    setAttackerSession('victim_b3', '');

    $result = DB::select("SELECT * FROM library WHERE book = 'wartest-b3-private'");

    expect($result)->toBeEmpty('SECURITY BREACH: Empty string token matched NULL creator_token!');
});

test('WAR GAME B4: NULL session values do not grant universal access', function () {
    $victim = createWarGameUser([
        'name' => 'victim_b4',
        'email' => 'victim_b4@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-b4-private',
        'title' => 'Private',
        'creator' => 'victim_b4',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Attack: Try to set session vars to NULL somehow
    // PostgreSQL set_config doesn't accept NULL directly, but let's verify behavior
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");

    $result = DB::select("SELECT * FROM library WHERE book = 'wartest-b4-private'");

    expect($result)->toBeEmpty('SECURITY BREACH: NULL/empty session granted access!');
});

// ==========================================
// SECTION C: DATA EXFILTRATION ATTACKS
// ==========================================

test('WAR GAME C1: username alone does NOT grant access to private library', function () {
    $victim = createWarGameUser([
        'name' => 'victim_c1',
        'email' => 'victim_c1@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-c1-private',
        'title' => 'Secret Documents',
        'creator' => 'victim_c1',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Attack: Attacker knows username (public info) but not the token
    setAttackerSession('victim_c1', 'not-the-real-token');

    $result = DB::select("SELECT * FROM library WHERE creator = 'victim_c1'");

    expect($result)->toBeEmpty('SECURITY BREACH: Username-only accessed private library!');
});

test('WAR GAME C2: username alone does NOT grant access to private highlights', function () {
    $victim = createWarGameUser([
        'name' => 'victim_c2',
        'email' => 'victim_c2@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-c2-book',
        'title' => 'Book',
        'creator' => 'victim_c2',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    createWarGameHyperlight([
        'book' => 'wartest-c2-book',
        'hyperlight_id' => 'wartest-hl-c2',
        'creator' => 'victim_c2',
        'creator_token' => null, // NULL for logged-in users
        'highlightedText' => 'Secret highlight',
    ]);

    setAttackerSession('victim_c2', 'wrong-token');

    $result = DB::select("SELECT * FROM hyperlights WHERE creator = 'victim_c2'");

    expect($result)->toBeEmpty('SECURITY BREACH: Username-only accessed private highlights!');
});

test('WAR GAME C3: username alone does NOT grant access to private hypercites', function () {
    $victim = createWarGameUser([
        'name' => 'victim_c3',
        'email' => 'victim_c3@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-c3-book',
        'title' => 'Book',
        'creator' => 'victim_c3',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    createWarGameHypercite([
        'book' => 'wartest-c3-book',
        'hyperciteId' => 'wartest-hc-c3',
        'creator' => 'victim_c3',
        'creator_token' => null,
        'hypercitedText' => 'Secret citation',
    ]);

    setAttackerSession('victim_c3', 'wrong-token');

    $result = DB::select("SELECT * FROM hypercites WHERE creator = 'victim_c3'");

    expect($result)->toBeEmpty('SECURITY BREACH: Username-only accessed private hypercites!');
});

test('WAR GAME C4: attacker cannot read victim email from users table', function () {
    $victim = createWarGameUser([
        'name' => 'victim_c4',
        'email' => 'secret_email@wartest.com',
    ]);

    setAttackerSession('', ''); // No auth

    // Attempt to extract email
    $result = DB::select("SELECT email FROM users WHERE name = 'victim_c4'");

    expect($result)->toBeEmpty('SECURITY BREACH: Attacker extracted victim email!');
});

test('WAR GAME C5: attacker with own valid session cannot read other users data', function () {
    // Create two users
    $attacker = createWarGameUser([
        'name' => 'attacker_c5',
        'email' => 'attacker_c5@wartest.com',
    ]);

    $victim = createWarGameUser([
        'name' => 'victim_c5',
        'email' => 'victim_c5@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-c5-victim-private',
        'title' => 'Victim Secret',
        'creator' => 'victim_c5',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Attack: Attacker has valid session for THEIR account, tries to read victim data
    setAttackerSession($attacker->name, $attacker->user_token);

    $result = DB::select("SELECT * FROM library WHERE creator = 'victim_c5'");

    expect($result)->toBeEmpty('SECURITY BREACH: User A accessed User B private data!');
});

test('WAR GAME C6: attacker cannot enumerate other users via users table', function () {
    createWarGameUser(['name' => 'user1_c6', 'email' => 'user1_c6@wartest.com']);
    createWarGameUser(['name' => 'user2_c6', 'email' => 'user2_c6@wartest.com']);
    createWarGameUser(['name' => 'user3_c6', 'email' => 'user3_c6@wartest.com']);

    setAttackerSession('', '');

    // Try to enumerate users
    $result = DB::select("SELECT name, email FROM users WHERE email LIKE '%@wartest.com'");

    expect($result)->toBeEmpty('SECURITY BREACH: Attacker enumerated users!');
});

// ==========================================
// SECTION D: DATA MODIFICATION ATTACKS
// ==========================================

test('WAR GAME D1: attacker cannot UPDATE victim private book visibility', function () {
    $victim = createWarGameUser([
        'name' => 'victim_d1',
        'email' => 'victim_d1@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-d1-private',
        'title' => 'Private',
        'creator' => 'victim_d1',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    setAttackerSession('victim_d1', 'wrong-token');

    // Attack: Try to make private book public
    DB::statement("UPDATE library SET visibility = 'public' WHERE book = 'wartest-d1-private'");

    // Verify via admin that visibility wasn't changed
    $book = DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-d1-private')->first();

    expect($book->visibility)->toBe('private', 'SECURITY BREACH: Attacker changed book visibility!');
});

test('WAR GAME D2: attacker cannot DELETE victim content', function () {
    $victim = createWarGameUser([
        'name' => 'victim_d2',
        'email' => 'victim_d2@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-d2-private',
        'title' => 'Delete Target',
        'creator' => 'victim_d2',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    setAttackerSession('victim_d2', 'wrong-token');

    // Attack: Try to delete victim's book
    DB::statement("DELETE FROM library WHERE book = 'wartest-d2-private'");

    // Verify via admin that book still exists
    $book = DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-d2-private')->first();

    expect($book)->not->toBeNull('SECURITY BREACH: Attacker deleted victim book!');
});

test('WAR GAME D3: attacker cannot INSERT content as victim (logged-in user)', function () {
    $victim = createWarGameUser([
        'name' => 'victim_d3',
        'email' => 'victim_d3@wartest.com',
    ]);

    setAttackerSession('victim_d3', 'wrong-token');

    // Attack: Try to create content under victim's name
    $insertAttempted = false;
    try {
        DB::statement("
            INSERT INTO library (book, title, creator, creator_token, visibility, created_at, updated_at, raw_json)
            VALUES ('wartest-d3-fake', 'Fake Book', 'victim_d3', NULL, 'public', NOW(), NOW(), '{}')
        ");
        $insertAttempted = true;
    } catch (\Exception $e) {
        // Expected - RLS should block the insert
    }

    // Verify via admin that no fake book was created
    $fakeBook = DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-d3-fake')->first();

    expect($fakeBook)->toBeNull('SECURITY BREACH: Attacker created content as victim!');
});

test('WAR GAME D4: attacker cannot modify victim user record', function () {
    $victim = createWarGameUser([
        'name' => 'victim_d4',
        'email' => 'victim_d4@wartest.com',
    ]);

    setAttackerSession('victim_d4', 'wrong-token');

    // Attack: Try to change victim's email
    DB::statement("UPDATE users SET email = 'hacked@evil.com' WHERE name = 'victim_d4'");

    // Verify email wasn't changed
    $user = DB::connection('pgsql_admin')->table('users')->where('name', 'victim_d4')->first();

    expect($user->email)->toBe('victim_d4@wartest.com', 'SECURITY BREACH: Attacker modified victim user!');
});

test('WAR GAME D5: attacker cannot delete victim highlights', function () {
    $victim = createWarGameUser([
        'name' => 'victim_d5',
        'email' => 'victim_d5@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-d5-book',
        'title' => 'Book',
        'creator' => 'victim_d5',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    createWarGameHyperlight([
        'book' => 'wartest-d5-book',
        'hyperlight_id' => 'wartest-hl-d5',
        'creator' => 'victim_d5',
        'creator_token' => null,
        'highlightedText' => 'Important',
    ]);

    setAttackerSession('victim_d5', 'wrong-token');

    DB::statement("DELETE FROM hyperlights WHERE hyperlight_id = 'wartest-hl-d5'");

    $highlight = DB::connection('pgsql_admin')->table('hyperlights')->where('hyperlight_id', 'wartest-hl-d5')->first();

    expect($highlight)->not->toBeNull('SECURITY BREACH: Attacker deleted victim highlight!');
});

// ==========================================
// SECTION E: RLS BYPASS ATTEMPTS
// ==========================================

test('WAR GAME E1: fake user_home type does NOT grant access to non-user-home content', function () {
    $victim = createWarGameUser([
        'name' => 'victim_e1',
        'email' => 'victim_e1@wartest.com',
    ]);

    // Create a REAL private book (not a user home)
    createWarGameLibrary([
        'book' => 'wartest-e1-private',
        'title' => 'Private Not Home',
        'creator' => 'victim_e1',
        'creator_token' => null,
        'visibility' => 'private',
        'raw_json' => json_encode(['type' => 'book']), // Not user_home
    ]);

    setAttackerSession('', '');

    // The attacker can't access this even though they might try to manipulate the query
    $result = DB::select("SELECT * FROM library WHERE book = 'wartest-e1-private'");

    expect($result)->toBeEmpty('SECURITY BREACH: Private non-user-home content was accessible!');
});

test('WAR GAME E2: user_home exception only applies to actual user_home entries', function () {
    $victim = createWarGameUser([
        'name' => 'victim_e2',
        'email' => 'victim_e2@wartest.com',
    ]);

    // Create an actual user home page
    createWarGameLibrary([
        'book' => 'wartest-e2-home',
        'title' => "victim_e2's library",
        'creator' => 'victim_e2',
        'creator_token' => null,
        'visibility' => 'public',
        'raw_json' => json_encode(['type' => 'user_home', 'username' => 'victim_e2']),
    ]);

    // Create a private book for same user
    createWarGameLibrary([
        'book' => 'wartest-e2-private',
        'title' => 'Secret',
        'creator' => 'victim_e2',
        'creator_token' => null,
        'visibility' => 'private',
        'raw_json' => json_encode(['type' => 'book']),
    ]);

    setAttackerSession('', '');

    // Should be able to see user home
    $homeResult = DB::select("SELECT * FROM library WHERE book = 'wartest-e2-home'");
    expect($homeResult)->toHaveCount(1);

    // Should NOT be able to see private book
    $privateResult = DB::select("SELECT * FROM library WHERE book = 'wartest-e2-private'");
    expect($privateResult)->toBeEmpty('SECURITY BREACH: user_home exception leaked to other content!');
});

test('WAR GAME E3: NULL creator with wrong token is blocked (anonymous content protection)', function () {
    // Anonymous user's content
    $anonToken = Str::uuid()->toString();

    createWarGameLibrary([
        'book' => 'wartest-e3-anon',
        'title' => 'Anonymous Content',
        'creator' => null, // Anonymous
        'creator_token' => $anonToken,
        'visibility' => 'private',
    ]);

    // Attack: Different token
    setAttackerSession('', Str::uuid()->toString());

    $result = DB::select("SELECT * FROM library WHERE book = 'wartest-e3-anon'");

    expect($result)->toBeEmpty('SECURITY BREACH: Wrong token accessed anonymous content!');
});

test('WAR GAME E4: attacker cannot access nodes of private book via direct query', function () {
    $victim = createWarGameUser([
        'name' => 'victim_e4',
        'email' => 'victim_e4@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-e4-book',
        'title' => 'Private Book',
        'creator' => 'victim_e4',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Create a node for the book
    DB::connection('pgsql_admin')->table('nodes')->insert([
        'book' => 'wartest-e4-book',
        'startLine' => 100,
        'chunk_id' => 0,
        'node_id' => 'wartest-node-e4',
        'content' => '<p>Secret content</p>',
        'plainText' => 'Secret content',
        'raw_json' => json_encode(['content' => '<p>Secret content</p>']),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    setAttackerSession('victim_e4', 'wrong-token');

    $result = DB::select("SELECT * FROM nodes WHERE book = 'wartest-e4-book'");

    expect($result)->toBeEmpty('SECURITY BREACH: Attacker accessed nodes of private book!');

    // Cleanup
    DB::connection('pgsql_admin')->table('nodes')->where('book', 'wartest-e4-book')->delete();
});

// ==========================================
// SECTION F: SECURITY DEFINER FUNCTION ABUSE
// ==========================================

test('WAR GAME F1: auth_lookup_user returns only safe columns', function () {
    $victim = createWarGameUser([
        'name' => 'victim_f1',
        'email' => 'secret_f1@wartest.com',
    ]);

    setAttackerSession('', '');

    // Call auth_lookup_user (used for login)
    $result = DB::select("SELECT * FROM auth_lookup_user(?)", ['secret_f1@wartest.com']);

    expect($result)->toHaveCount(1);

    $columns = array_keys((array) $result[0]);

    // Should only have: id, password, remember_token
    expect($columns)->toContain('id');
    expect($columns)->toContain('password');
    expect($columns)->toContain('remember_token');
    expect($columns)->not->toContain('email', 'auth_lookup_user should not return email');
    expect($columns)->not->toContain('user_token', 'auth_lookup_user should not return user_token');
});

test('WAR GAME F2: lookup_user_by_name returns only public info', function () {
    $victim = createWarGameUser([
        'name' => 'victim_f2',
        'email' => 'secret_f2@wartest.com',
    ]);

    setAttackerSession('', '');

    // Call lookup_user_by_name (used for public profiles)
    $result = DB::select("SELECT * FROM lookup_user_by_name(?)", ['victim_f2']);

    expect($result)->toHaveCount(1);

    $columns = array_keys((array) $result[0]);

    // Should only have: id, name, created_at
    expect($columns)->toContain('id');
    expect($columns)->toContain('name');
    expect($columns)->toContain('created_at');
    expect($columns)->not->toContain('email', 'lookup_user_by_name should not return email');
    expect($columns)->not->toContain('user_token', 'lookup_user_by_name should not return user_token');
    expect($columns)->not->toContain('password', 'lookup_user_by_name should not return password');
});

test('WAR GAME F3: SQL injection in auth_lookup_user email parameter does not work', function () {
    $victim = createWarGameUser([
        'name' => 'victim_f3',
        'email' => 'safe_f3@wartest.com',
    ]);

    setAttackerSession('', '');

    // Attempt SQL injection in email parameter
    $maliciousEmail = "' OR '1'='1";
    $result = DB::select("SELECT * FROM auth_lookup_user(?)", [$maliciousEmail]);

    // Should return nothing - injection should not work
    expect($result)->toBeEmpty('Potential SQL injection vulnerability in auth_lookup_user!');
});

test('WAR GAME F4: SECURITY DEFINER functions do not allow table drops', function () {
    // This tests that even if an attacker could somehow inject into a SECURITY DEFINER function,
    // they cannot perform DDL operations

    setAttackerSession('', '');

    $errorOccurred = false;
    try {
        // Attempt to call a function with SQL injection that tries to drop tables
        // This should fail at multiple levels
        DB::select("SELECT * FROM auth_lookup_user(?)", ["'; DROP TABLE users; --"]);
    } catch (\Exception $e) {
        $errorOccurred = true;
    }

    // Verify users table still exists
    $tableExists = DB::connection('pgsql_admin')
        ->select("SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = 'users')");

    expect($tableExists[0]->exists)->toBeTrue('CRITICAL: users table was dropped!');
});

// ==========================================
// SECTION G: EDGE CASES & RACE CONDITIONS
// ==========================================

test('WAR GAME G1: changing session vars mid-query does not leak data', function () {
    $victim = createWarGameUser([
        'name' => 'victim_g1',
        'email' => 'victim_g1@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-g1-private',
        'title' => 'Private',
        'creator' => 'victim_g1',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Start without auth
    setAttackerSession('', '');

    // Try to query while also setting session vars (simulating a race)
    $result = DB::select("
        SELECT * FROM library
        WHERE book = 'wartest-g1-private'
        AND set_config('app.current_user', 'victim_g1', false) IS NOT NULL
    ");

    // Even with set_config in WHERE clause, RLS is evaluated before the query runs
    expect($result)->toBeEmpty('SECURITY BREACH: Mid-query session change leaked data!');
});

test('WAR GAME G2: special characters in session vars do not cause issues', function () {
    // Test that special characters in session vars don't cause SQL injection
    $specialChars = ["'; DROP TABLE users; --", "\\", "\x00", "NULL", "''"];

    foreach ($specialChars as $char) {
        setAttackerSession($char, $char);

        // Should not cause errors or unexpected behavior
        $result = DB::select("SELECT current_setting('app.current_user', true) as user_val");

        // Just verify the query runs without crashing
        expect($result)->toBeArray();
    }
});

test('WAR GAME G3: unicode/multibyte characters do not bypass RLS', function () {
    $victim = createWarGameUser([
        'name' => 'victim_g3',
        'email' => 'victim_g3@wartest.com',
    ]);

    createWarGameLibrary([
        'book' => 'wartest-g3-private',
        'title' => 'Private',
        'creator' => 'victim_g3',
        'creator_token' => null,
        'visibility' => 'private',
    ]);

    // Try unicode variations of the username (excluding invalid UTF-8 sequences
    // which PostgreSQL correctly rejects - that's a security feature!)
    $attacks = [
        "ⱱictim_g3", // Unicode lookalike characters (Latin small letter V with hook)
        "victim_g3%00", // URL-encoded null (stays as literal string)
        "VICTIM_G3", // Case variation
        "victim_g3 ", // Trailing space
        " victim_g3", // Leading space
    ];

    foreach ($attacks as $attack) {
        setAttackerSession($attack, '');

        $result = DB::select("SELECT * FROM library WHERE book = 'wartest-g3-private'");

        expect($result)->toBeEmpty("SECURITY BREACH: Unicode attack '$attack' worked!");
    }
});

// ==========================================
// SECTION H: CONTENT THEFT PREVENTION
// ==========================================

test('WAR GAME H1: attacker cannot steal anonymous content via transfer function', function () {
    // This tests the fix for the content theft vulnerability:
    // Previously, attacker could:
    // 1. Get creator_token via check_book_visibility
    // 2. Call transfer_anonymous_library to steal content
    // Now: Transfer functions require session token to match

    $anonToken = Str::uuid()->toString();

    // Create anonymous content
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => 'wartest-h1-anon',
        'title' => 'Anonymous Content',
        'creator' => null,
        'creator_token' => $anonToken,
        'visibility' => 'private',
        'raw_json' => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Attacker has no valid session (or wrong token)
    setAttackerSession('', '');

    // Attacker gets the token via check_book_visibility
    $visibility = DB::selectOne('SELECT * FROM check_book_visibility(?)', ['wartest-h1-anon']);
    $stolenToken = $visibility->creator_token;

    // Attacker tries to transfer using stolen token - should be blocked!
    $exceptionThrown = false;
    try {
        DB::select('SELECT transfer_anonymous_library(?, ?)', [$stolenToken, 'attacker']);
    } catch (\Exception $e) {
        $exceptionThrown = true;
        expect($e->getMessage())->toContain('Unauthorized');
    }

    expect($exceptionThrown)->toBeTrue('SECURITY BREACH: Transfer function accepted stolen token!');

    // Verify content was not stolen
    $book = DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-h1-anon')->first();
    expect($book->creator)->toBeNull('SECURITY BREACH: Content owner was changed!');
    expect($book->creator_token)->toBe($anonToken, 'SECURITY BREACH: Content token was modified!');

    // Cleanup
    DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-h1-anon')->delete();
});

test('WAR GAME H2: legitimate owner CAN transfer their anonymous content', function () {
    $anonToken = Str::uuid()->toString();

    // Create anonymous content
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => 'wartest-h2-anon',
        'title' => 'My Content',
        'creator' => null,
        'creator_token' => $anonToken,
        'visibility' => 'private',
        'raw_json' => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Owner sets their session with the correct token (simulates login with anon_token cookie)
    DB::statement("SELECT set_config('app.current_user', 'new_user', false)");
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$anonToken]);

    // Owner transfers their own content - should work!
    $result = DB::selectOne('SELECT transfer_anonymous_library(?, ?)', [$anonToken, 'new_user']);
    expect($result->transfer_anonymous_library)->toBe(1);

    // Verify transfer worked
    $book = DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-h2-anon')->first();
    expect($book->creator)->toBe('new_user');
    expect($book->creator_token)->toBeNull(); // Cleared after transfer

    // Cleanup
    DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-h2-anon')->delete();
});

test('WAR GAME H3: attacker with different token cannot steal content', function () {
    $victimToken = Str::uuid()->toString();
    $attackerToken = Str::uuid()->toString();

    // Create victim's anonymous content
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => 'wartest-h3-victim',
        'title' => 'Victim Content',
        'creator' => null,
        'creator_token' => $victimToken,
        'visibility' => 'private',
        'raw_json' => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Attacker has their own valid token (different from victim's)
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$attackerToken]);

    // Attacker somehow got victim's token and tries to transfer
    $exceptionThrown = false;
    try {
        DB::select('SELECT transfer_anonymous_library(?, ?)', [$victimToken, 'attacker']);
    } catch (\Exception $e) {
        $exceptionThrown = true;
    }

    expect($exceptionThrown)->toBeTrue('SECURITY BREACH: Cross-token transfer was allowed!');

    // Verify content was not stolen
    $book = DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-h3-victim')->first();
    expect($book->creator)->toBeNull();

    // Cleanup
    DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-h3-victim')->delete();
});

test('WAR GAME G4: invalid UTF-8 sequences are rejected by PostgreSQL (security feature)', function () {
    // This test verifies that PostgreSQL rejects invalid UTF-8 sequences
    // This is a SECURITY FEATURE - not a vulnerability

    // Test overlong UTF-8 encoding - this should be rejected
    $exceptionThrown = false;
    try {
        // Reconnect to get clean transaction state
        DB::reconnect();
        setAttackerSession("victim\xc0\x80", '');
    } catch (\Exception $e) {
        $exceptionThrown = true;
        // Verify it's a character encoding error
        expect($e->getMessage())->toContain('invalid byte sequence');
    }

    // PostgreSQL should reject invalid UTF-8
    expect($exceptionThrown)->toBeTrue("PostgreSQL accepted invalid UTF-8 sequence (overlong encoding)!");

    // Test null byte - this may be handled differently
    // Reconnect to ensure clean transaction state
    DB::reconnect();
    $nullByteThrown = false;
    try {
        setAttackerSession("victim\x00test", '');
    } catch (\Exception $e) {
        $nullByteThrown = true;
    }

    // Null bytes are also typically rejected or sanitized
    // If not thrown, verify no data leaked
    if (!$nullByteThrown) {
        // If PostgreSQL accepted the null byte, verify RLS still works
        createWarGameLibrary([
            'book' => 'wartest-g4-test',
            'title' => 'Test',
            'creator' => 'victim',
            'creator_token' => null,
            'visibility' => 'private',
        ]);

        $result = DB::select("SELECT * FROM library WHERE book = 'wartest-g4-test'");
        expect($result)->toBeEmpty("Null byte in username bypassed RLS!");

        // Cleanup
        DB::connection('pgsql_admin')->table('library')->where('book', 'wartest-g4-test')->delete();
    }
});
