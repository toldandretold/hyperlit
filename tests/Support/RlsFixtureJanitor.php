<?php

namespace Tests\Support;

use Illuminate\Support\Facades\DB;

/**
 * Deferred teardown for SeedsRlsFixtures.
 *
 * cleanupRlsFixtures() runs in an afterEach — BEFORE RefreshDatabase rolls back the test's
 * `pgsql` transaction. If the test's request touched a seeded row (a login stamps the user,
 * an upsert UPDATEs a library row), that row is still locked by the open transaction, the
 * admin DELETE hits its 2s lock_timeout, and the row survives. The old code then simply
 * forgot the ids ("removed later" — by nothing), which is how the test DB accumulated
 * ~35,000 `@rlstest.local` users (4–5k per full run) until terms:announce, which mails every
 * active user, faked 35k mailables and the suite died at its 512 MB memory limit.
 *
 * Now a row that couldn't be deleted is parked here and retried at the NEXT test's cleanup
 * (the previous transaction has rolled back by then) and once more at process shutdown.
 * Static and outside the trait on purpose: every Pest file is its own class, and trait
 * statics would be per-class.
 */
final class RlsFixtureJanitor
{
    /** @var array<int, true> */
    private static array $users = [];

    /** @var array<string, true> */
    private static array $books = [];

    private static bool $shutdownRegistered = false;

    public const BOOK_TABLES = ['hyperlights', 'hypercites', 'nodes', 'book_images', 'book_audio', 'book_audio_meta', 'library'];

    /** @param list<int> $userIds @param list<string> $books */
    public static function park(array $userIds, array $books): void
    {
        foreach ($userIds as $id) {
            self::$users[$id] = true;
        }
        foreach ($books as $b) {
            self::$books[$b] = true;
        }
        if (! self::$shutdownRegistered) {
            self::$shutdownRegistered = true;
            register_shutdown_function(static function () {
                try {
                    self::flush(final: true);
                } catch (\Throwable) {
                    // the app may already be torn down — nothing more we can do
                }
            });
        }
    }

    /**
     * Retry everything parked. Rows still locked stay parked; rows that can never be deleted
     * (a billing_ledger FK on the user) are dropped on the final pass rather than retried forever.
     */
    public static function flush(bool $final = false): void
    {
        if (! self::$users && ! self::$books) {
            return;
        }
        $admin = DB::connection('pgsql_admin');

        if (self::$books) {
            $books = array_keys(self::$books);
            $ok = true;
            foreach (self::BOOK_TABLES as $table) {
                try {
                    $admin->table($table)->whereIn('book', $books)->delete();
                } catch (\Throwable $e) {
                    $ok = $ok && ! self::isLock($e);
                }
            }
            if ($ok || $final) {
                self::$books = [];
            }
        }

        foreach (array_keys(self::$users) as $id) {
            try {
                $admin->table('users')->where('id', $id)->delete();
                unset(self::$users[$id]);
            } catch (\Throwable $e) {
                if (! self::isLock($e) || $final) {
                    unset(self::$users[$id]); // e.g. FK from billing_ledger — not ours to force
                }
            }
        }
    }

    private static function isLock(\Throwable $e): bool
    {
        $code = $e instanceof \PDOException || $e instanceof \Illuminate\Database\QueryException ? (string) $e->getCode() : '';

        return $code === '55P03' || str_contains($e->getMessage(), 'lock timeout');
    }
}
