<?php

/**
 * terms:announce — one notification + one queued mail per ACTIVE user,
 * idempotent per version via the notifications dedupe index.
 *
 * Suite reality (see tests/Pest.php): Feature/Console gets the
 * SeedsRlsFixtures trait but NOT the afterEach cleanup hook, and the global
 * admin-table wipe list does not include `notifications` — so this file
 * cleans up BOTH its notification rows and its seeded users explicitly
 * (admin writes escape RefreshDatabase).
 */

use App\Mail\TermsPublishedMail;
use App\Services\Notifications\NotificationWriter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('notifications')
        ->where('type', NotificationWriter::TYPE_TERMS_PUBLISHED)->delete();
    $this->cleanupRlsFixtures();
    DB::connection('pgsql_admin')->table('users')
        ->where('email', 'like', '%@terms-announce.local')->delete();
});

function seedAnnounceUsers($test): array
{
    return (function () {
        $s = strtolower(Str::random(6));
        $active = $this->seedUser(['name' => 'tann_active'.$s, 'email' => 'act'.$s.'@terms-announce.local']);
        $unverified = $this->seedUser(['name' => 'tann_unver'.$s, 'email' => 'unv'.$s.'@terms-announce.local', 'email_verified_at' => null]);
        $deleted = $this->seedUser(['name' => 'tann_del'.$s, 'email' => 'del'.$s.'@terms-announce.local', 'status' => 'deleted']);
        $deleting = $this->seedUser(['name' => 'tann_ing'.$s, 'email' => 'ing'.$s.'@terms-announce.local', 'status' => 'deleting']);
        $tombstone = $this->seedUser(['name' => 'tann_tomb'.$s, 'email' => 'tomb'.$s.'@tombstone.invalid']);

        return compact('active', 'unverified', 'deleted', 'deleting', 'tombstone');
    })->call($test);
}

function termsRowsFor(array $names): int
{
    return DB::connection('pgsql_admin')->table('notifications')
        ->where('type', NotificationWriter::TYPE_TERMS_PUBLISHED)
        ->whereIn('recipient', $names)
        ->count();
}

test('dry-run (the default) writes nothing and queues nothing', function () {
    Mail::fake();
    $u = seedAnnounceUsers($this);

    $this->artisan('terms:announce')->assertExitCode(0);

    expect(termsRowsFor([$u['active']->name]))->toBe(0);
    Mail::assertNothingQueued();
});

test('--force notifies and mails exactly the active users, idempotently', function () {
    Mail::fake();
    $u = seedAnnounceUsers($this);
    $version = config('terms.version');

    $this->artisan('terms:announce --force')->assertExitCode(0);

    // Active + unverified get rows; deleted/deleting/tombstone get nothing.
    foreach ([$u['active'], $u['unverified']] as $user) {
        $row = DB::connection('pgsql_admin')->table('notifications')
            ->where('type', NotificationWriter::TYPE_TERMS_PUBLISHED)
            ->where('recipient', $user->name)->first();
        expect($row)->not->toBeNull();
        expect($row->actor)->toBe('Hyperlit');
        expect($row->book)->toBe('terms');
        expect($row->root_book)->toBe('terms');
        expect($row->subject_id)->toBe($version);
    }
    expect(termsRowsFor([$u['deleted']->name, $u['deleting']->name, $u['tombstone']->name]))->toBe(0);

    // Default mails ALL active users, including the unverified one.
    Mail::assertQueued(TermsPublishedMail::class, fn ($m) => $m->recipientEmail === $u['active']->email);
    Mail::assertQueued(TermsPublishedMail::class, fn ($m) => $m->recipientEmail === $u['unverified']->email);
    Mail::assertNotQueued(TermsPublishedMail::class, fn ($m) => $m->recipientEmail === $u['deleted']->email);

    // Re-run: the dedupe index absorbs every repeat for the same version.
    $before = termsRowsFor([$u['active']->name, $u['unverified']->name]);
    $this->artisan('terms:announce --force')->assertExitCode(0);
    expect(termsRowsFor([$u['active']->name, $u['unverified']->name]))->toBe($before);
});

test('--verified-only still notifies everyone in-app but skips unverified email', function () {
    Mail::fake();
    $u = seedAnnounceUsers($this);

    $this->artisan('terms:announce --force --verified-only')->assertExitCode(0);

    expect(termsRowsFor([$u['unverified']->name]))->toBe(1);
    Mail::assertQueued(TermsPublishedMail::class, fn ($m) => $m->recipientEmail === $u['active']->email);
    Mail::assertNotQueued(TermsPublishedMail::class, fn ($m) => $m->recipientEmail === $u['unverified']->email);
});

test('--dry-run wins over --force (the safe flag always wins)', function () {
    Mail::fake();
    $u = seedAnnounceUsers($this);

    $this->artisan('terms:announce --force --dry-run')->assertExitCode(0);

    expect(termsRowsFor([$u['active']->name]))->toBe(0);
    Mail::assertNothingQueued();
});

test('the announcement email blade actually renders', function () {
    $html = (new TermsPublishedMail('x@example.test', 'SomeReader', '17 November 2026'))->render();
    expect($html)->toContain('SomeReader');
    expect($html)->toContain('17 November 2026');
    expect($html)->toContain('hyperlit.io/terms');
});
