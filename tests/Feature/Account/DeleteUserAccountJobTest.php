<?php

/**
 * DeleteUserAccountJob::handle — the thin queue wrapper around the service:
 * admin-connection user load (a worker has no RLS session context), the
 * already-deleted short-circuit, and the completion mail actually rendering
 * (Mail::fake asserts sending, never compiles the blade — a template typo
 * would otherwise first surface in prod).
 */

use App\Jobs\DeleteUserAccountJob;
use App\Mail\AccountDeletedMail;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

afterEach(function () {
    $a = DB::connection('pgsql_admin');
    $a->table('deleted_usernames')->where('name', 'like', 'jobdel_%')->delete();
    $ids = $a->table('users')->where('email', 'like', '%@jobdel.local')
        ->orWhere('name', 'like', 'deleted_%')->where('email', 'like', '%@tombstone.invalid')
        ->pluck('id');
    if ($ids->isNotEmpty()) {
        $a->table('billing_ledger')->whereIn('user_id', $ids)->delete();
        $a->table('users')->whereIn('id', $ids)->delete();
    }
});

test('handle() loads the user via admin, runs the full deletion, and is idempotent', function () {
    Mail::fake();
    $user = $this->seedUser(['name' => 'jobdel_'.strtolower(Str::random(6)), 'email' => 'j'.Str::random(6).'@jobdel.local']);
    $originalName = $user->name;

    (new DeleteUserAccountJob($user->id, 'delete', 'delete'))->handle();

    $row = DB::connection('pgsql_admin')->table('users')->where('id', $user->id)->first();
    expect($row->status)->toBe('deleted');
    expect($row->name)->toBe('deleted_'.$user->id);
    expect(DB::connection('pgsql_admin')->table('deleted_usernames')->where('name', $originalName)->exists())->toBeTrue();
    Mail::assertSent(AccountDeletedMail::class, 1);

    // Second run short-circuits on status='deleted' — no second mail, no throw.
    (new DeleteUserAccountJob($user->id, 'delete', 'delete'))->handle();
    Mail::assertSent(AccountDeletedMail::class, 1);
});

test('handle() is a quiet no-op for an unknown user id', function () {
    Mail::fake();
    (new DeleteUserAccountJob(999999999, 'delete', 'delete'))->handle();
    Mail::assertNothingSent();
});

test('the completion mail blade actually renders', function () {
    $html = (new AccountDeletedMail('gone@example.test', 'SomeUser'))->render();

    expect($html)->toContain('SomeUser');
    expect($html)->toContain('permanently retired');
});
