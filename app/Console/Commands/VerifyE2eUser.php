<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Mark an e2e-registered user's email as verified so the publishing gate
 * (config/publishing.php — accounts created after the cutoff need a verified
 * email to make a book public) doesn't block e2e flows that register a fresh
 * user through the real signup form and then publish (e.g.
 * tests/e2e/specs/workflows/notifications.spec.js).
 *
 *   php artisan e2e:verify-user <name>
 *
 * The e2e users register with @test.local addresses that have no mailbox, so
 * clicking the real verification link is impossible — this is the seam. Uses
 * the BYPASSRLS `pgsql_admin` connection like the other e2e:* seeders, and
 * refuses to run in production.
 */
class VerifyE2eUser extends Command
{
    protected $signature = 'e2e:verify-user {name : username to mark email-verified}';

    protected $description = 'Mark an e2e test user email-verified (dev/test only; unblocks the publish gate)';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('e2e:verify-user is a test seam and never runs in production.');
            return self::FAILURE;
        }

        $name = (string) $this->argument('name');
        $updated = DB::connection('pgsql_admin')
            ->table('users')
            ->where('name', $name)
            ->whereNull('email_verified_at')
            ->update(['email_verified_at' => now()]);

        if ($updated === 0) {
            $exists = DB::connection('pgsql_admin')->table('users')->where('name', $name)->exists();
            if (! $exists) {
                $this->error("No user named {$name}.");
                return self::FAILURE;
            }
            $this->info("User {$name} was already verified.");
            return self::SUCCESS;
        }

        $this->info("Marked {$name} email-verified.");
        return self::SUCCESS;
    }
}
