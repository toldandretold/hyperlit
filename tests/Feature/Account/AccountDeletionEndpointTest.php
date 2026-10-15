<?php

/**
 * POST /api/user/account-deletion — the gate in front of DeleteUserAccountJob.
 */

use App\Jobs\DeleteUserAccountJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('users')->where('email', 'like', '%@acctdel-ep.local')->delete();
});

test('it requires authentication', function () {
    $this->postJson('/api/user/account-deletion', [
        'password' => 'x', 'books' => 'delete', 'annotations' => 'delete',
    ])->assertStatus(401);
    $this->getJson('/api/user/account-deletion/preview')->assertStatus(401);
});

test('a wrong password refuses and dispatches nothing', function () {
    Queue::fake();
    $user = $this->seedUser(['email' => 'a'.Str::random(6).'@acctdel-ep.local']);

    $this->actingAs($user)->postJson('/api/user/account-deletion', [
        'password' => 'not-the-password', 'books' => 'delete', 'annotations' => 'delete',
    ])->assertStatus(422);

    Queue::assertNothingPushed();
    expect(DB::connection('pgsql_admin')->table('users')->where('id', $user->id)->value('status'))
        ->not->toBe('deleting');
});

test('invalid choice enums are refused', function () {
    Queue::fake();
    $user = $this->seedUser(['email' => 'b'.Str::random(6).'@acctdel-ep.local']);

    $this->actingAs($user)->postJson('/api/user/account-deletion', [
        'password' => 'password', 'books' => 'obliterate', 'annotations' => 'delete',
    ])->assertStatus(422);

    Queue::assertNothingPushed();
});

test('success marks deleting, kills sessions/tokens, dispatches on the default queue', function () {
    Queue::fake();
    $user = $this->seedUser(['email' => 'c'.Str::random(6).'@acctdel-ep.local']);
    $admin = DB::connection('pgsql_admin');
    $admin->table('personal_access_tokens')->insert([
        'tokenable_type' => \App\Models\User::class, 'tokenable_id' => $user->id,
        'name' => 'acctdel-ep', 'token' => hash('sha256', Str::random(10)),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->actingAs($user)->postJson('/api/user/account-deletion', [
        'password' => 'password', 'books' => 'anonymize', 'annotations' => 'keep',
    ])->assertStatus(202)->assertJson(['success' => true]);

    expect($admin->table('users')->where('id', $user->id)->value('status'))->toBe('deleting');
    expect($admin->table('personal_access_tokens')->where('tokenable_id', $user->id)->exists())->toBeFalse();

    Queue::assertPushed(DeleteUserAccountJob::class, function ($job) use ($user) {
        return $job->userId === $user->id
            && $job->booksChoice === 'anonymize'
            && $job->annotationsChoice === 'keep'
            && $job->queue === null; // default queue — NOT the imports lane
    });
});

test('login is refused while deleting and after deleted', function () {
    foreach (['deleting', 'deleted'] as $status) {
        $email = 'd'.Str::random(6).'@acctdel-ep.local';
        $this->seedUser(['email' => $email, 'status' => $status]);

        $this->postJson('/api/login', ['email' => $email, 'password' => 'password'])
            ->assertStatus(422);
        $this->assertGuest();
    }
});
