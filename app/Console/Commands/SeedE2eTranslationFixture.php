<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Seed the deterministic Chinese fixture book the translation e2e billing
 * suite drives end-to-end (tests/e2e/specs/stripe/translation-billing.spec.js).
 * Idempotent — safe to re-run any time; a test seam that refuses production.
 *
 *   php artisan e2e:seed-translation-fixture
 *
 * The node TEXT mirrors tests/Feature/Translation/BookTranslationTest.php's
 * fixture exactly, because the fake Fireworks server
 * (tests/e2e/fixtures/fake-fireworks.mjs) answers from the same literal map —
 * change a string here and the fake stops answering it.
 *
 * CRITICAL: every seed also PURGES prior translation copies of the fixture
 * (library.translated_from lineage + their nodes/footnotes/bibliography) and
 * the fixture's storage/app/book-translations/* run dirs — the commons dedupe
 * (one visible translation blocks a second) would otherwise 409 every re-run.
 *
 * Uses the BYPASSRLS `pgsql_admin` connection (same rationale as
 * SeedE2eFixtures). After seeding, set in tests/e2e/.env.e2e:
 *   E2E_TRANSLATION_BOOK=book_e2e_translation_fixture
 */
class SeedE2eTranslationFixture extends Command
{
    protected $signature = 'e2e:seed-translation-fixture {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed the public Chinese fixture book for the translation billing e2e suite (idempotent; purges prior copies)';

    public const BOOK = 'book_e2e_translation_fixture';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('e2e:seed-translation-fixture is a test seam and never runs in production.');

            return self::FAILURE;
        }

        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');

        $user = $admin->table('users')->where('email', $email)->first();
        if (! $user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");

            return self::FAILURE;
        }

        $this->purgePriorCopies($admin);
        $this->seedBook($admin, $user);

        $this->info('Seeded: '.self::BOOK.' (public Chinese book; prior translation copies purged).');
        $this->line('Ensure tests/e2e/.env.e2e has:');
        $this->line('  E2E_TRANSLATION_BOOK='.self::BOOK);

        return self::SUCCESS;
    }

    /**
     * Delete every translation copy of the fixture (whoever commissioned it)
     * plus its run dirs, so the next run starts from "no translation exists".
     */
    private function purgePriorCopies($admin): void
    {
        $copies = $admin->table('library')->where('translated_from', self::BOOK)->pluck('book');
        foreach ($copies as $copy) {
            $admin->table('nodes')->where('book', $copy)->orWhere('book', 'like', $copy.'/%')->delete();
            foreach (['footnotes', 'bibliography', 'library'] as $table) {
                $admin->table($table)->where('book', $copy)->delete();
            }
        }
        if ($copies->isNotEmpty()) {
            $this->line('  ✓ purged '.$copies->count().' prior translation cop'.($copies->count() === 1 ? 'y' : 'ies'));
        }

        // Run dirs are keyed "{book}--{target}--{userId}" (sanitized) — sweep
        // every dir belonging to the fixture, whatever user commissioned it.
        $root = storage_path('app/book-translations');
        if (is_dir($root)) {
            foreach (File::directories($root) as $dir) {
                if (str_starts_with(basename($dir), self::BOOK.'--')) {
                    File::deleteDirectory($dir);
                }
            }
        }

        // A crashed e2e worker leaves the fixture's job RESERVED — invisible
        // to the next worker for the full retry_after (7500s). Sweep queued
        // AND reserved translation jobs that carry the fixture's book id.
        $stale = DB::table('jobs')->where('queue', 'translation')
            ->where('payload', 'like', '%'.self::BOOK.'%')->delete();
        if ($stale > 0) {
            $this->line("  ✓ cleared {$stale} stale queued/reserved translation job(s)");
        }
    }

    private function seedBook($admin, object $user): void
    {
        $book = self::BOOK;
        $now = now();

        $admin->table('library')->updateOrInsert(['book' => $book], [
            'book' => $book,
            'title' => '长相思 (E2E Translation Fixture)',
            'author' => 'E2E Fixtures',
            'creator' => $user->name,
            'creator_token' => $user->user_token,
            // PUBLIC: the throwaway billing-spec user is never the owner, and
            // the commons rule needs a public original to mint a public copy.
            'visibility' => 'public',
            'listed' => false,
            'language' => 'zh-Hans',
            'license' => 'cc-by-sa-4.0',
            'has_nodes' => true,
            'is_publisher_uploaded' => false,
            'encrypted' => false,
            // A fresh seed must not read as "edited since" on copies minted
            // moments later: stamp the content timestamp at seed time.
            'annotations_updated_at' => (int) (microtime(true) * 1000),
            'timestamp' => (string) (int) (microtime(true) * 1000),
            // No stale lineage: re-seeding over a book that was itself a copy
            // in some earlier experiment must clear it.
            'translated_from' => null,
            'translation_target' => null,
            'raw_json' => json_encode(['book' => $book, 'title' => '长相思 (E2E Translation Fixture)'], JSON_UNESCAPED_UNICODE),
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        // RESET nodes/footnotes (not just upsert): deterministic content is the
        // contract with the fake Fireworks answers map.
        $admin->table('nodes')->where('book', $book)->orWhere('book', 'like', $book.'/%')->delete();
        $admin->table('footnotes')->where('book', $book)->delete();

        $nodes = [
            [1, "{$book}_n1", '[]', '<h2 id="1" data-node-id="'.$book.'_n1">第一章</h2>', 'h2'],
            [2, "{$book}_n2", '["'.$book.'Fn1"]',
                '<p id="2" data-node-id="'.$book.'_n2">小六走进屋子<sup fn-count-id="1" id="'.$book.'Fnref1"><a class="footnote-ref" href="#'.$book.'Fn1">1</a></sup>。<u id="hypercite_e2e" class="single">他笑了</u>。</p>', 'p'],
            // Reference-list node: must come through the copy VERBATIM (never
            // sent to the model) — the e2e asserts the fake never saw it.
            [3, "{$book}_n3", '[]',
                '<p id="3" data-node-id="'.$book.'_n3" data-static-content="bibliography"><span><span>马克思</span></span><span> (1867) </span><i>资本论</i></p>', 'p'],
        ];
        foreach ($nodes as [$line, $nodeId, $footnotes, $content, $type]) {
            $admin->table('nodes')->insert([
                'book' => $book, 'startLine' => $line, 'chunk_id' => 0,
                'node_id' => $nodeId, 'type' => $type, 'footnotes' => $footnotes,
                'content' => $content, 'plainText' => trim(strip_tags($content)),
                'created_at' => $now, 'updated_at' => $now,
            ]);
        }
        $admin->table('nodes')->insert([
            'book' => "{$book}/{$book}Fn1", 'startLine' => 1, 'chunk_id' => 0,
            'node_id' => "{$book}_s1", 'type' => 'p', 'footnotes' => '[]',
            'content' => '<p id="1" data-node-id="'.$book.'_s1">注释内容。</p>',
            'plainText' => '注释内容。',
            'created_at' => $now, 'updated_at' => $now,
        ]);
        $admin->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => "{$book}Fn1", 'sub_book_id' => "{$book}/{$book}Fn1",
            'content' => '<p>注释内容。</p>', 'created_at' => $now, 'updated_at' => $now,
        ]);

        $this->line("  ✓ {$book}");
    }
}
