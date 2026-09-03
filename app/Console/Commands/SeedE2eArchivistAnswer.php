<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Seed the deterministic AI-Archivist answer fixture the e2e SPA-nav spec
 * relies on (tests/e2e/specs/ai-archivist/home-archivist-spa-nav.spec.js).
 * Idempotent — safe to re-run any time; nodes/annotations are RESET each run
 * so app-side edits can't poison the fixture.
 *
 *   php artisan e2e:seed-archivist-answer
 *
 * The spec route-mocks POST /api/ai-brain/ask to return ANSWER_BOOK's id, but
 * everything downstream is REAL: mountAnswerBook loads the book through the
 * feed pathway, the ↗ anchor opens the hypercite container from the live
 * hypercites row, "See in source text" navigates to SOURCE_BOOK, and the
 * back-nav restore re-fetches the answer. So all three rows must exist:
 *   1. SOURCE_BOOK  — public book + one node (the hypercited passage).
 *   2. ANSWER_BOOK  — PRIVATE book owned by the e2e user (author 'AI
 *      Archivist', like AiBrainController::ask mints) whose answer node
 *      carries the flat ↗ anchor.
 *   3. hypercites row on SOURCE_BOOK — creator 'AIarchivist', the e2e user
 *      granted co-author, citedIN pointing at ANSWER_BOOK's anchor.
 *
 * Uses the BYPASSRLS `pgsql_admin` connection (same rationale as
 * SeedE2eFixtures / tests/Support/SeedsRlsFixtures.php).
 */
class SeedE2eArchivistAnswer extends Command
{
    protected $signature = 'e2e:seed-archivist-answer {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed the AI-Archivist answer + source + hypercite fixture for the e2e SPA-nav spec (idempotent)';

    public const SOURCE_BOOK = 'book_e2e_archivist_source';
    public const ANSWER_BOOK = 'book_e2e_archivist_answer';
    public const HYPERCITE_ID = 'hypercite_e2earchv1';

    public function handle(): int
    {
        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');

        $user = $admin->table('users')->where('email', $email)->first();
        if (!$user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");
            return self::FAILURE;
        }

        $this->seedSourceBook($admin, $user);
        $this->seedAnswerBook($admin, $user);
        $this->seedHypercite($admin, $user);

        $this->info('Seeded: ' . self::ANSWER_BOOK . ' (private answer) + ' . self::SOURCE_BOOK . ' (public source) + ' . self::HYPERCITE_ID . '.');

        return self::SUCCESS;
    }

    private function libraryRow(object $user, string $book, string $title, array $extra = []): array
    {
        return array_merge([
            'book' => $book,
            'title' => $title,
            'author' => 'E2E Fixtures',
            'type' => 'book',
            'creator' => $user->name,
            'creator_token' => null,
            'visibility' => 'private',
            'listed' => false,
            'license' => 'all-rights-reserved',
            'has_nodes' => true,
            'is_publisher_uploaded' => false,
            'encrypted' => false,
            'annotations_updated_at' => (int) (microtime(true) * 1000),
            'timestamp' => (string) (int) (microtime(true) * 1000),
            'raw_json' => json_encode(['book' => $book, 'title' => $title]),
            'created_at' => now(),
            'updated_at' => now(),
        ], $extra);
    }

    private function nodeRow(string $book, int $startLine, string $content, string $type = 'p'): array
    {
        $nodeId = "{$book}_e2efix_{$startLine}";
        return [
            'book' => $book,
            'startLine' => $startLine,
            'chunk_id' => 0,
            'node_id' => $nodeId,
            'type' => $type,
            'content' => $content,
            'plainText' => trim(strip_tags($content)),
            'created_at' => now(),
            'updated_at' => now(),
        ];
    }

    private function resetNodes($admin, string $book, array $nodes): void
    {
        // RESET (not just upsert): edits synced back by app runs against the
        // fixture would otherwise accumulate — deterministic fixtures need a
        // clean slate every seed (same rule as SeedE2eFixtures::seedA11yBook).
        $admin->table('nodes')->where('book', $book)->delete();
        foreach ($nodes as [$startLine, $content, $type]) {
            $admin->table('nodes')->insert($this->nodeRow($book, $startLine, $content, $type));
        }
    }

    private function seedSourceBook($admin, object $user): void
    {
        $book = self::SOURCE_BOOK;
        $admin->table('library')->updateOrInsert(['book' => $book], $this->libraryRow($user, $book, 'E2E Archivist Source', [
            'author' => 'Source Author',
            'visibility' => 'public',
            'listed' => true,
        ]));

        $this->resetNodes($admin, $book, [
            [100, '<h1 id="100" data-node-id="' . $book . '_e2efix_100">E2E Archivist Source</h1>', 'h1'],
            [200, '<p id="200" data-node-id="' . $book . '_e2efix_200">Delinking is not autarky but the submission of external relations to the logic of internal development, a deliberately long fixture passage for the archivist hypercite to land on.</p>', 'p'],
            [300, '<p id="300" data-node-id="' . $book . '_e2efix_300">Closing paragraph so the source book has scroll depth.</p>', 'p'],
        ]);

        $this->line("  ✓ {$book}");
    }

    private function seedAnswerBook($admin, object $user): void
    {
        $book = self::ANSWER_BOOK;
        $hc = self::HYPERCITE_ID;
        $source = self::SOURCE_BOOK;
        $admin->table('library')->updateOrInsert(['book' => $book], $this->libraryRow($user, $book, 'AI Archivist: e2e test answer', [
            'author' => 'AI Archivist',
        ]));

        $this->resetNodes($admin, $book, [
            [1, '<p id="1" data-node-id="' . $book . '_e2efix_1"><b>Prompt</b>: "What does the e2e fixture archive say about delinking?"</p>', 'p'],
            [2, '<p id="2" data-node-id="' . $book . '_e2efix_2"><b>AI Archivist</b>:</p>', 'p'],
            // Anchor placement mirrors normalizeCitationTokenPlacement (the ↗
            // follows the sentence's punctuation, never precedes it).
            [3, '<p id="3" data-node-id="' . $book . '_e2efix_3">The fixture source treats delinking as the submission of external relations to internal development.<a id="' . $hc . '" href="/' . $source . '#' . $hc . '" class="open-icon">↗</a> This paragraph exists so the answer has a live hypercite anchor.</p>', 'p'],
            [4, '<p id="4" data-node-id="' . $book . '_e2efix_4">A closing paragraph so the answer render has some depth.</p>', 'p'],
        ]);

        // Clean any annotations the app synced onto the answer during past runs
        $admin->table('hyperlights')->where('book', $book)->delete();

        $this->line("  ✓ {$book}");
    }

    private function seedHypercite($admin, object $user): void
    {
        $source = self::SOURCE_BOOK;
        $hc = self::HYPERCITE_ID;
        $sourceNodeId = $source . '_e2efix_200';

        // Deterministic: drop every hypercite on the fixture source first
        $admin->table('hypercites')->where('book', $source)->delete();
        $admin->table('hypercites')->insert([
            'book' => $source,
            'hyperciteId' => $hc,
            'node_id' => json_encode([$sourceNodeId]),
            'charData' => json_encode([$sourceNodeId => ['charStart' => 0, 'charEnd' => 96]]),
            'citedIN' => json_encode(['/' . self::ANSWER_BOOK . '#' . $hc]),
            'hypercitedText' => 'Delinking is not autarky but the submission of external relations to the logic of internal development',
            'relationshipStatus' => 'couple',
            'creator' => 'AIarchivist',
            'access_granted' => json_encode([$user->name => 'co-author']),
            'creator_token' => null,
            'time_since' => now()->timestamp,
            'raw_json' => json_encode([]),
        ]);

        $this->line("  ✓ {$hc} on {$source}");
    }
}
