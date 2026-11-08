<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Seed the fixture books the licence e2e suite drives
 * (tests/e2e/specs/workflows/licenses.spec.js). Idempotent and RESETTING — every run puts
 * each fixture back to its starting licence and deletes the licence BOOKS earlier runs minted,
 * so the suite never inherits state. A test seam that refuses production.
 *
 *   php artisan e2e:seed-license-fixtures
 *
 * Fixtures (all owned by the e2e user, public, one heading + one paragraph):
 *   book_e2e_lic_harvest  CC-BY-NC-ND-4.0, work_license 'cc-by-nc-nd' — stands in for a harvested
 *                         work (no harvest runs: what matters is a code the picker doesn't offer
 *                         by default surviving an unrelated edit — the title-edit wipe)
 *   book_e2e_lic_open     Open-Unspecified, work_license 'other-oa' — the upstream statement note
 *   book_e2e_lic_legacy   'all-rights-reserved' (legacy lower-case code) — must label as All
 *                         rights reserved, never as the site default
 *   book_e2e_lic_work_a   the user's own writing, site default — picker + custom-licence flows
 *   book_e2e_lic_work_b   second own book — reusing a licence page across works
 *
 * work_license is not client-writable, which is why this is a seeder and not API calls.
 */
class SeedE2eLicenseFixtures extends Command
{
    protected $signature = 'e2e:seed-license-fixtures {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed/reset the licence e2e fixture books (idempotent; purges licence books from earlier runs)';

    /** Licence books minted by the spec are titled with this prefix so they can be purged. */
    public const LICENSE_TITLE_PREFIX = 'E2E Licence';

    public const FIXTURES = [
        'book_e2e_lic_harvest' => ['title' => 'E2E Licence Fixture — Harvested NC-ND', 'license' => 'CC-BY-NC-ND-4.0', 'work_license' => 'cc-by-nc-nd', 'oa_status' => 'gold'],
        'book_e2e_lic_open' => ['title' => 'E2E Licence Fixture — Open Unspecified', 'license' => 'Open-Unspecified', 'work_license' => 'other-oa', 'oa_status' => 'green'],
        'book_e2e_lic_legacy' => ['title' => 'E2E Licence Fixture — Legacy Code', 'license' => 'all-rights-reserved', 'work_license' => null, 'oa_status' => null],
        'book_e2e_lic_work_a' => ['title' => 'E2E Licence Fixture — Own Work A', 'license' => 'CC-BY-SA-4.0-NO-AI', 'work_license' => null, 'oa_status' => null],
        'book_e2e_lic_work_b' => ['title' => 'E2E Licence Fixture — Own Work B', 'license' => 'CC-BY-SA-4.0-NO-AI', 'work_license' => null, 'oa_status' => null],
    ];

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('e2e:seed-license-fixtures is a test seam and never runs in production.');

            return self::FAILURE;
        }

        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');
        $user = $admin->table('users')->where('email', $email)->first();
        if (! $user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");

            return self::FAILURE;
        }

        // Licence books minted by earlier runs (via POST /api/license-books).
        $minted = $admin->table('library')
            ->where('creator', $user->name)
            ->where('title', 'like', self::LICENSE_TITLE_PREFIX.' %')
            ->whereNotIn('book', array_keys(self::FIXTURES))
            ->pluck('book');
        foreach ($minted as $b) {
            $admin->table('nodes')->where('book', $b)->delete();
            $admin->table('library')->where('book', $b)->delete();
        }
        if ($minted->isNotEmpty()) {
            $this->line("  ✓ purged {$minted->count()} licence book(s) from earlier runs");
        }

        $now = now();
        foreach (self::FIXTURES as $book => $f) {
            $admin->table('library')->updateOrInsert(['book' => $book], [
                'book' => $book,
                'title' => $f['title'],
                'author' => 'E2E Fixtures',
                'type' => 'book',
                'creator' => $user->name,
                'creator_token' => $user->user_token,
                'visibility' => 'public',
                'listed' => false,
                'has_nodes' => true,
                'encrypted' => false,
                'license' => $f['license'],
                'custom_license_text' => null,
                'license_url' => null,
                'license_book' => null,
                'license_book_at' => null,
                'work_license' => $f['work_license'],
                'oa_status' => $f['oa_status'],
                'bibtex' => null,
                'slug' => null,
                'timestamp' => (string) (int) (microtime(true) * 1000),
                'annotations_updated_at' => 0,
                'raw_json' => json_encode(['book' => $book, 'title' => $f['title']]),
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $admin->table('nodes')->where('book', $book)->delete();
            foreach ([
                [100, 'h1', '<h1 id="100" data-node-id="'.$book.'_n1">'.e($f['title']).'</h1>'],
                [200, 'p', '<p id="200" data-node-id="'.$book.'_n2">Licence fixture body text for '.$book.'.</p>'],
            ] as $i => [$line, $type, $content]) {
                $admin->table('nodes')->insert([
                    'book' => $book, 'startLine' => $line, 'chunk_id' => 0,
                    'node_id' => $book.'_n'.($i + 1), 'type' => $type, 'footnotes' => '[]',
                    'content' => $content, 'plainText' => trim(strip_tags($content)),
                    'created_at' => $now, 'updated_at' => $now,
                ]);
            }
            $this->line("  ✓ {$book} ({$f['license']})");
        }

        // The fixtures' prerender caches would serve the PREVIOUS run's licence in <head>.
        foreach (array_keys(self::FIXTURES) as $book) {
            try {
                app(\App\Services\BookCache::class)->invalidate($book);
            } catch (\Throwable) {
                // best effort
            }
        }

        return self::SUCCESS;
    }
}
