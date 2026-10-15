<?php

namespace App\Jobs;

use App\Models\User;
use App\Services\UserAccountDeletionService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Runs the whole-account deletion in the background (a user with hundreds of
 * books takes minutes). DEFAULT queue on purpose — this is not a user import,
 * so the `imports` priority lane rules don't apply.
 *
 * tries=1: the service's phases are individually idempotent, but a failure
 * should be a LOUD operator event (the account sits in status='deleting',
 * login already blocked), not a silent retry loop. Re-dispatching after a fix
 * is safe.
 */
class DeleteUserAccountJob implements ShouldQueue, ShouldBeUnique
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 900;

    public int $tries = 1;

    public function __construct(
        public int $userId,
        public string $booksChoice,
        public string $annotationsChoice,
    ) {}

    public function uniqueId(): string
    {
        return 'delete-account-'.$this->userId;
    }

    public function handle(): void
    {
        // The worker has no RLS session context, so read via pgsql_admin —
        // a default-connection read would silently return nothing.
        $row = DB::connection('pgsql_admin')->table('users')->where('id', $this->userId)->first();
        if (! $row) {
            Log::warning('DeleteUserAccountJob: user not found', ['user_id' => $this->userId]);

            return;
        }
        if ($row->status === 'deleted') {
            Log::info('DeleteUserAccountJob: already deleted', ['user_id' => $this->userId]);

            return;
        }

        $user = new User;
        $user->forceFill((array) $row);
        $user->exists = true;

        (new UserAccountDeletionService)->deleteAccount(
            $user,
            $this->booksChoice,
            $this->annotationsChoice,
        );
    }

    public function failed(\Throwable $e): void
    {
        Log::error('DeleteUserAccountJob FAILED — account left in status=deleting (login blocked); fix and re-dispatch', [
            'user_id' => $this->userId,
            'error' => $e->getMessage(),
        ]);
    }
}
