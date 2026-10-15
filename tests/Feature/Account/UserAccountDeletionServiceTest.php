<?php

/**
 * UserAccountDeletionService — per-table disposition under the user's choices.
 *
 * Seeding rides SeedsRlsFixtures (BYPASSRLS pgsql_admin; wired for
 * Feature/Account in tests/Pest.php). Admin-committed rows escape
 * RefreshDatabase, so everything extra this file seeds is cleaned in afterEach,
 * name-randomised per the username-identity gate.
 */

use App\Mail\AccountDeletedMail;
use App\Models\User;
use App\Services\UserAccountDeletionService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

function admin()
{
    return DB::connection('pgsql_admin');
}

afterEach(function () {
    $a = admin();
    $a->table('deleted_usernames')->where('name', 'like', 'acctdel_%')->delete();
    // Ledger rows FIRST — billing_ledger.user_id's FK (no cascade, the very
    // constraint the tombstone design exists for) blocks the users delete.
    $fixtureUsers = $a->table('users')
        ->where('email', 'like', '%@acctdel.local')->orWhere('email', 'like', '%@tombstone.invalid')
        ->pluck('id');
    if ($fixtureUsers->isNotEmpty()) {
        $a->table('billing_ledger')->whereIn('user_id', $fixtureUsers)->delete();
        $a->table('users')->whereIn('id', $fixtureUsers)->delete();
    }
    foreach (['book_reads', 'user_reading_positions'] as $t) {
        $a->table($t)->where('book', 'like', 'acctdel_%')->delete();
    }
    $a->table('page_views')->where('page', 'acctdel_home')->delete();
    $a->table('notifications')->where('book', 'like', 'acctdel_%')->delete();
    $a->table('book_likes')->where('book', 'like', 'acctdel_%')->delete();
    $a->table('shelves')->where('name', 'like', 'acctdel_%')->delete();
    $a->table('nodes_history')->where('book', 'like', 'acctdel_%')->delete();
    $a->table('billing_ledger')->whereRaw("description LIKE 'acctdel%'")->delete();
    foreach (['library', 'nodes', 'hyperlights', 'hypercites', 'footnotes'] as $t) {
        $a->table($t)->where('book', 'like', 'acctdel_%')->delete();
    }
});

/**
 * One fully-furnished account: a private book, a public slugged book, a
 * foreign public book (other user) carrying the subject's hyperlight +
 * hypercite, telemetry, notification, like, shelf, ledger row, passkey, vault,
 * token, nodes_history residue, and a generated user-home book.
 */
function seedAccount($test): array
{
    // The seed* helpers are protected trait methods — bind into the test case.
    return (function () {
    $suffix = strtolower(Str::random(6));
    $user = $this->seedUser(['name' => 'acctdel_u'.$suffix, 'email' => 'u'.$suffix.'@acctdel.local']);
    $other = $this->seedUser(['name' => 'acctdel_o'.$suffix, 'email' => 'o'.$suffix.'@acctdel.local']);

    $private = 'acctdel_priv_'.$suffix;
    $public = 'acctdel_pub_'.$suffix;
    $foreign = 'acctdel_foreign_'.$suffix;

    $this->seedLibrary(['book' => $private, 'creator' => $user->name, 'visibility' => 'private', 'title' => 'Private Book']);
    $this->seedLibrary(['book' => $public, 'creator' => $user->name, 'visibility' => 'public', 'title' => 'Public Book', 'slug' => 'acctdel-slug-'.$suffix]);
    $this->seedLibrary(['book' => $foreign, 'creator' => $other->name, 'visibility' => 'public', 'title' => 'Foreign Book']);
    foreach ([$private, $public, $foreign] as $b) {
        $this->seedNode(['book' => $b, 'startLine' => '100', 'node_id' => $b.'_n1', 'content' => '<p>hello</p>']);
    }

    // Subject's annotations on the OTHER user's book (public + private sub-book).
    $hlPub = 'HL_pub'.$suffix;
    $hlPriv = 'HL_priv'.$suffix;
    $this->seedHyperlight(['book' => $foreign, 'hyperlight_id' => $hlPub, 'creator' => $user->name, 'highlightedText' => 'x', 'sub_book_id' => $foreign.'/'.$hlPub]);
    $this->seedHyperlight(['book' => $foreign, 'hyperlight_id' => $hlPriv, 'creator' => $user->name, 'highlightedText' => 'y', 'sub_book_id' => $foreign.'/'.$hlPriv]);
    $this->seedLibrary(['book' => $foreign.'/'.$hlPub, 'creator' => $user->name, 'visibility' => 'public']);
    $this->seedLibrary(['book' => $foreign.'/'.$hlPriv, 'creator' => $user->name, 'visibility' => 'private']);
    $this->seedHypercite(['book' => $foreign, 'hyperciteId' => 'HC_'.$suffix, 'creator' => $user->name, 'hypercitedText' => 'q', 'citedIN' => ['/'.$public.'#x']]);

    // Generated user-home book (phase D).
    $sanitized = \App\Support\UserHomeBookNames::sanitize($user->name);
    $this->seedLibrary(['book' => $sanitized, 'creator' => $user->name, 'visibility' => 'public']);
    $this->seedNode(['book' => $sanitized, 'startLine' => '1', 'node_id' => $sanitized.'_card', 'content' => '<p>card</p>']);

    $a = admin();
    $a->table('book_reads')->insert(['book' => $public, 'user_name' => $user->name, 'read_date' => now()->toDateString(), 'created_at' => now(), 'updated_at' => now()]);
    $a->table('page_views')->insert(['page' => 'acctdel_home', 'user_name' => $user->name, 'view_date' => now()->toDateString(), 'created_at' => now(), 'updated_at' => now()]);
    $a->table('user_reading_positions')->insert(['book' => $public, 'user_name' => $user->name]);
    $a->table('notifications')->insert([
        ['recipient' => $user->name, 'actor' => $other->name, 'type' => 'like', 'book' => $public, 'root_book' => $public, 'created_at' => now()],
        ['recipient' => $other->name, 'actor' => $user->name, 'type' => 'like', 'book' => $foreign, 'root_book' => $foreign, 'created_at' => now()],
    ]);
    $a->table('book_likes')->insert(['book' => $foreign, 'creator' => $user->name, 'created_at' => now()]);
    $shelfId = $a->table('shelves')->insertGetId(['creator' => $user->name, 'name' => 'acctdel_shelf'.$suffix, 'slug' => 'acctdel-shelf-'.$suffix, 'created_at' => now(), 'updated_at' => now()]);
    $a->table('shelf_items')->insert(['shelf_id' => $shelfId, 'book' => $foreign]);
    $a->table('billing_ledger')->insert(['id' => Str::uuid()->toString(), 'user_id' => $user->id, 'type' => 'debit', 'amount' => 1.5, 'description' => 'acctdel test charge', 'category' => 'test', 'balance_after' => 0, 'created_at' => now()]);
    $a->table('passkey_credentials')->insert(['user_id' => $user->id, 'credential_id' => 'cred'.$suffix, 'public_key' => 'pk', 'prf_salt' => 'salt', 'created_at' => now(), 'updated_at' => now()]);
    $a->table('user_e2ee_vaults')->insert(['user_id' => $user->id, 'recovery_wrapped_vault_key' => 'k', 'recovery_kdf_params' => '{}', 'created_at' => now(), 'updated_at' => now()]);
    $a->table('personal_access_tokens')->insert(['tokenable_type' => User::class, 'tokenable_id' => $user->id, 'name' => 'acctdel', 'token' => hash('sha256', $suffix), 'created_at' => now(), 'updated_at' => now()]);
    $a->table('nodes_history')->insert(['book' => $private, 'chunk_id' => 0, 'startLine' => '100', 'created_at' => now()]);

    return compact('user', 'other', 'private', 'public', 'foreign', 'hlPub', 'hlPriv', 'suffix', 'shelfId', 'sanitized');
    })->call($test);
}

test('delete/delete wipes everything and tombstones the account', function () {
    Mail::fake();
    $s = seedAccount($this);
    $a = admin();
    $originalName = $s['user']->name;
    $originalToken = $s['user']->user_token;

    (new UserAccountDeletionService)->deleteAccount($s['user'], 'delete', 'delete');

    // Private book: hard-deleted outright (never externally linkable).
    expect($a->table('library')->where('book', $s['private'])->exists())->toBeFalse();
    expect($a->table('nodes')->where('book', $s['private'])->exists())->toBeFalse();

    // Public slugged book: tombstone row — 410-able, slug reserved, content scrubbed.
    $pub = $a->table('library')->where('book', $s['public'])->first();
    expect($pub)->not->toBeNull();
    expect($pub->visibility)->toBe('deleted');
    expect($pub->slug)->toBe('acctdel-slug-'.$s['suffix']);
    expect($pub->title)->toBeNull();
    expect($pub->creator)->toBe('deleted_'.$s['user']->id);
    expect($a->table('nodes')->where('book', $s['public'])->exists())->toBeFalse();

    // Generated user-home book: gone entirely.
    expect($a->table('library')->where('book', $s['sanitized'])->exists())->toBeFalse();
    expect($a->table('nodes')->where('book', $s['sanitized'])->exists())->toBeFalse();

    // Foreign annotations: rows and their sub-book library rows gone.
    expect($a->table('hyperlights')->where('creator', $originalName)->exists())->toBeFalse();
    expect($a->table('hypercites')->where('creator', $originalName)->exists())->toBeFalse();
    expect($a->table('library')->where('book', $s['foreign'].'/'.$s['hlPub'])->exists())->toBeFalse();

    // The other user's book itself is untouched.
    expect($a->table('nodes')->where('book', $s['foreign'])->exists())->toBeTrue();

    // Telemetry: anonymized, rows intact.
    expect($a->table('book_reads')->where('book', $s['public'])->whereNull('user_name')->exists())->toBeTrue();
    expect($a->table('page_views')->where('page', 'acctdel_home')->whereNull('user_name')->exists())->toBeTrue();
    expect($a->table('book_reads')->where('user_name', $originalName)->exists())->toBeFalse();

    // Notifications: received gone, acted tombstoned.
    expect($a->table('notifications')->where('recipient', $originalName)->exists())->toBeFalse();
    expect($a->table('notifications')->where('actor', 'deleted_'.$s['user']->id)->exists())->toBeTrue();

    // Likes + shelves gone; billing ledger retained.
    expect($a->table('book_likes')->where('creator', $originalName)->exists())->toBeFalse();
    expect($a->table('shelves')->where('id', $s['shelfId'])->exists())->toBeFalse();
    expect($a->table('shelf_items')->where('shelf_id', $s['shelfId'])->exists())->toBeFalse();
    expect($a->table('billing_ledger')->where('user_id', $s['user']->id)->exists())->toBeTrue();

    // nodes_history purged for deleted books.
    expect($a->table('nodes_history')->where('book', $s['private'])->exists())->toBeFalse();

    // Tombstoned users row: renamed, scrubbed, token rotated, auth material gone.
    $row = $a->table('users')->where('id', $s['user']->id)->first();
    expect($row->name)->toBe('deleted_'.$s['user']->id);
    expect($row->email)->toContain('@tombstone.invalid');
    expect($row->status)->toBe('deleted');
    expect($row->user_token)->not->toBe($originalToken);
    expect((bool) $row->is_admin)->toBeFalse();
    expect($a->table('passkey_credentials')->where('user_id', $s['user']->id)->exists())->toBeFalse();
    expect($a->table('user_e2ee_vaults')->where('user_id', $s['user']->id)->exists())->toBeFalse();
    expect($a->table('personal_access_tokens')->where('tokenable_id', $s['user']->id)->exists())->toBeFalse();

    // Name retired + completion mail to the ORIGINAL address.
    expect($a->table('deleted_usernames')->where('name', $originalName)->exists())->toBeTrue();
    Mail::assertSent(AccountDeletedMail::class);
});

test('anonymize/anonymize keeps public work under the tombstone byline; private things still die', function () {
    Mail::fake();
    $s = seedAccount($this);
    $a = admin();
    $originalName = $s['user']->name;
    $tombstone = 'deleted_'.$s['user']->id;

    (new UserAccountDeletionService)->deleteAccount($s['user'], 'anonymize', 'anonymize');

    // Public book survives, anonymized, content intact.
    $pub = $a->table('library')->where('book', $s['public'])->first();
    expect($pub->visibility)->toBe('public');
    expect($pub->creator)->toBe($tombstone);
    expect($pub->creator_token)->toBeNull();
    expect($pub->title)->toBe('Public Book');
    expect($a->table('nodes')->where('book', $s['public'])->exists())->toBeTrue();

    // Private book still hard-deleted.
    expect($a->table('library')->where('book', $s['private'])->exists())->toBeFalse();

    // PUBLIC foreign annotation anonymized; PRIVATE one deleted regardless of choice.
    $hl = $a->table('hyperlights')->where('book', $s['foreign'])->where('hyperlight_id', $s['hlPub'])->first();
    expect($hl->creator)->toBe($tombstone);
    expect($a->table('hyperlights')->where('hyperlight_id', $s['hlPriv'])->exists())->toBeFalse();
    expect($a->table('library')->where('book', $s['foreign'].'/'.$s['hlPriv'])->exists())->toBeFalse();
    expect($a->table('hypercites')->where('book', $s['foreign'])->first()->creator)->toBe($tombstone);

    // Nothing left under the original name anywhere RLS compares.
    foreach (['library', 'hyperlights', 'hypercites', 'shelves', 'book_likes', 'pinned_books'] as $t) {
        expect($a->table($t)->where('creator', $originalName)->exists())->toBeFalse("{$t} still holds creator={$originalName}");
    }
});

test('keep/keep leaves public work attributed; account still dies', function () {
    Mail::fake();
    $s = seedAccount($this);
    $a = admin();
    $originalName = $s['user']->name;

    (new UserAccountDeletionService)->deleteAccount($s['user'], 'keep', 'keep');

    // Public book untouched (byline keeps the retired name by explicit choice).
    $pub = $a->table('library')->where('book', $s['public'])->first();
    expect($pub->visibility)->toBe('public');
    expect($pub->creator)->toBe($originalName);

    // Public foreign annotation untouched; private one still deleted.
    expect($a->table('hyperlights')->where('hyperlight_id', $s['hlPub'])->first()->creator)->toBe($originalName);
    expect($a->table('hyperlights')->where('hyperlight_id', $s['hlPriv'])->exists())->toBeFalse();

    // Private book gone; account tombstoned; name retired.
    expect($a->table('library')->where('book', $s['private'])->exists())->toBeFalse();
    expect($a->table('users')->where('id', $s['user']->id)->value('status'))->toBe('deleted');
    expect($a->table('deleted_usernames')->where('name', $originalName)->exists())->toBeTrue();
});
