<?php

namespace App\Console\Commands;

use App\Mail\TermsPublishedMail;
use App\Services\Notifications\NotificationWriter;
use Carbon\Carbon;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

/**
 * terms:announce — the notice duty behind config('terms.version').
 *
 * The terms promise ≥30 days' email + in-app notice before a material change
 * takes effect; this command IS that promise, made runnable. For every active
 * user it writes one in-app notification (NotificationWriter::termsPublished
 * — subject_id is the version, which rides the dedupe index, so RE-RUNNING
 * for the same version can never double-notify) and queues one
 * TermsPublishedMail on the default lane.
 *
 * afterCommit note: NotificationWriter wraps writes in DB::afterCommit, which
 * executes IMMEDIATELY when no transaction is open (vendor
 * DatabaseTransactionsManager::addCallback) — true here, so the writes land
 * synchronously inside the loop.
 *
 * Exclusions: tombstoned accounts (status deleted/deleting, @tombstone.invalid
 * emails). NULL-status users are NORMAL users — a bare whereNotIn would
 * silently drop them all (SQL NULL semantics), hence the grouped filter.
 *
 * Dry-run by default (house style); --verified-only limits EMAIL to users
 * with a verified address (deliverability escape hatch — mass-mailing
 * unverified addresses risks bounces) while the in-app notice still reaches
 * everyone. NOT scheduled: announcing terms is an operator decision.
 */
class TermsAnnounce extends Command
{
    protected $signature = 'terms:announce
        {--force : Actually write notifications and queue emails (default is a dry run)}
        {--dry-run : Explicit no-op — already the default; wins over --force}
        {--verified-only : Email only users with a verified address (in-app notice still goes to everyone)}';

    protected $description = 'Notify every active user, in-app and by email, that the terms at config(terms.version) take effect';

    public function handle(): int
    {
        $version = (string) config('terms.version');
        if ($version === '') {
            $this->error('config(terms.version) is empty — set it in config/terms.php first.');

            return self::FAILURE;
        }
        $effective = Carbon::parse($version)->format('j F Y');

        $dry = ! $this->option('force') || $this->option('dry-run');
        $verifiedOnly = (bool) $this->option('verified-only');
        $admin = DB::connection('pgsql_admin');

        $activeFilter = fn ($q) => $q
            ->where(fn ($s) => $s->whereNull('status')->orWhereNotIn('status', ['deleted', 'deleting']))
            ->where('email', 'not like', '%@tombstone.invalid');

        $total = $admin->table('users')->count();
        $active = $admin->table('users')->where($activeFilter)->count();
        $verified = $admin->table('users')->where($activeFilter)->whereNotNull('email_verified_at')->count();
        $alreadyNotified = $admin->table('notifications')
            ->where('type', NotificationWriter::TYPE_TERMS_PUBLISHED)
            ->where('subject_id', $version)
            ->count();

        $this->info("Terms version {$version} (effective {$effective})");
        $this->line("Users: {$total} total, {$active} active (".($total - $active).' excluded as deleted/deleting/tombstone)');
        $this->line("Email split: {$verified} verified, ".($active - $verified).' unverified'
            .($verifiedOnly ? ' — unverified will be SKIPPED for email (--verified-only)' : ' — ALL active users will be emailed'));
        $this->line("Already notified for this version: {$alreadyNotified} (dedupe skips them)");

        if ($dry) {
            $this->line('[dry-run] Nothing written, nothing queued. Run with --force to announce.');

            return self::SUCCESS;
        }

        $notified = 0;
        $mailed = 0;
        $admin->table('users')->where($activeFilter)
            ->orderBy('id')
            ->chunkById(500, function ($users) use ($version, $effective, $verifiedOnly, &$notified, &$mailed) {
                foreach ($users as $user) {
                    NotificationWriter::termsPublished(
                        $user->name,
                        $version,
                        'its Terms of Service and Privacy Policy',
                        "Effective {$effective}.",
                    );
                    $notified++;

                    if (! $verifiedOnly || $user->email_verified_at !== null) {
                        Mail::send(new TermsPublishedMail($user->email, $user->name, $effective));
                        $mailed++;
                    }
                }
            });

        $this->info("Done: {$notified} in-app notifications written (dedupe absorbed any repeats), {$mailed} emails queued on the default lane.");

        return self::SUCCESS;
    }
}
