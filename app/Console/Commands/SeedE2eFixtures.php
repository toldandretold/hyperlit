<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Seed the deterministic fixture books the e2e a11y suites rely on
 * (tests/e2e/specs/a11y/). Idempotent — safe to re-run any time.
 *
 *   php artisan e2e:seed-fixtures
 *
 * Seeds, owned by the e2e test user (E2E_USER_EMAIL / --email):
 *   1. book_e2e_encrypted_fixture — `encrypted = true` library row + one node.
 *      Navigating to it fires the REAL E2EE open-gate (pageLoad/initialChunk.ts
 *      awaits the unlock modal before render) — the path the standalone
 *      unlock-modal spec cannot reach. Content is a plaintext placeholder; the
 *      gate blocks before any content is rendered, so ciphertext isn't needed.
 *   2. book_e2e_a11y_fixture — a small plaintext book carrying one of every
 *      in-text interactable (footnote ref, hyperlight mark, hypercite pair,
 *      in-text citation, external link) for keyboard-hop and footnote specs.
 *
 * Uses the BYPASSRLS `pgsql_admin` connection (same rationale as
 * tests/Support/SeedsRlsFixtures.php — plain inserts are RLS-rejected without
 * an HTTP session token).
 *
 * After seeding, set in tests/e2e/.env.e2e:
 *   E2E_ENCRYPTED_BOOK=book_e2e_encrypted_fixture
 *   E2E_A11Y_BOOK=book_e2e_a11y_fixture
 */
class SeedE2eFixtures extends Command
{
    protected $signature = 'e2e:seed-fixtures {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed the encrypted + annotated fixture books used by the e2e a11y suites (idempotent)';

    public const ENCRYPTED_BOOK = 'book_e2e_encrypted_fixture';
    public const A11Y_BOOK = 'book_e2e_a11y_fixture';

    public function handle(): int
    {
        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');

        $user = $admin->table('users')->where('email', $email)->first();
        if (!$user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");
            return self::FAILURE;
        }

        $this->seedEncryptedBook($admin, $user);
        $this->seedA11yBook($admin, $user);

        $this->info('Seeded: ' . self::ENCRYPTED_BOOK . ' (encrypted gate) + ' . self::A11Y_BOOK . ' (annotated).');
        $this->line('Ensure tests/e2e/.env.e2e has:');
        $this->line('  E2E_ENCRYPTED_BOOK=' . self::ENCRYPTED_BOOK);
        $this->line('  E2E_A11Y_BOOK=' . self::A11Y_BOOK);

        return self::SUCCESS;
    }

    private function libraryRow(object $user, string $book, string $title, array $extra = []): array
    {
        return array_merge([
            'book' => $book,
            'title' => $title,
            'author' => 'E2E Fixtures',
            'creator' => $user->name,
            'creator_token' => $user->user_token,
            'visibility' => 'private',
            'listed' => false,
            'license' => 'all-rights-reserved',
            'has_nodes' => true,
            'is_publisher_uploaded' => false,
            'encrypted' => false,
            'annotations_updated_at' => (int) (microtime(true) * 1000), // bigint epoch ms
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

    private function upsertNode($admin, array $row): void
    {
        $admin->table('nodes')->updateOrInsert(
            ['book' => $row['book'], 'startLine' => $row['startLine']],
            $row
        );
    }

    private function seedEncryptedBook($admin, object $user): void
    {
        $book = self::ENCRYPTED_BOOK;
        $admin->table('library')->updateOrInsert(['book' => $book], $this->libraryRow($user, $book, 'E2E Encrypted Fixture', [
            'encrypted' => true,
            // Dummy wrapped key — the gate shows the unlock modal long before any
            // unwrap attempt, and the spec never unlocks (no passkey in CI).
            'wrapped_dek' => 'e2e-dummy-wrapped-dek',
        ]));

        $this->upsertNode($admin, $this->nodeRow(
            $book,
            100,
            '<p id="100" data-node-id="' . $book . '_e2efix_100">E2E encrypted fixture placeholder (gate blocks before render).</p>'
        ));

        $this->line("  ✓ {$book}");
    }

    private function seedA11yBook($admin, object $user): void
    {
        $book = self::A11Y_BOOK;
        $admin->table('library')->updateOrInsert(['book' => $book], $this->libraryRow($user, $book, 'E2E A11y Fixture'));

        // RESET nodes (not just upsert): app runs against these books can sync
        // edits back (e.g. opening a then-empty footnote bootstraps an empty
        // sub-book node and autosaves it over the fixture row). Deterministic
        // fixtures need a clean slate every seed.
        $admin->table('nodes')->where('book', $book)->delete();
        $admin->table('nodes')->where('book', 'like', $book . '/%')->delete();

        $fnCount = 1;
        $fnSupId = 'Fn1700000000000001';           // sup id in content
        // The client resolves footnotes by IDB key [parentBook, supId] and
        // derives the sub-book as {book}/{supId} (footnoteHandler.ts:49,56) —
        // footnoteId must be the RAW sup id, not a book-prefixed variant.
        $footnoteId = $fnSupId;
        $subBookId = $book . '/' . $fnSupId;

        $nodes = [
            [100, '<h1 id="100" data-node-id="' . $book . '_e2efix_100">E2E A11y Fixture</h1>', 'h1'],
            [200, '<p id="200" data-node-id="' . $book . '_e2efix_200">A paragraph with a footnote reference'
                . '<sup class="footnote-ref" fn-count-id="' . $fnCount . '" id="' . $fnSupId . '">1</sup>'
                . ' for keyboard tests.</p>', 'p'],
            [300, '<p id="300" data-node-id="' . $book . '_e2efix_300">A paragraph with '
                . '<mark data-highlight-count="1" data-highlight-ids="HL_e2efix_1">a hyperlighted phrase</mark>'
                . ' and <u class="couple" id="hypercite_e2efix_1">a hypercited phrase</u> inside it.</p>', 'p'],
            [400, '<p id="400" data-node-id="' . $book . '_e2efix_400">A claim with an in-text citation '
                . '[<a class="in-text-citation" href="#bib.bib1" title="">1</a>] and an external link to '
                . '<a href="https://example.org/e2e-fixture">example.org</a>.</p>', 'p'],
            [500, '<p id="500" data-node-id="' . $book . '_e2efix_500">Closing paragraph so the book has scroll depth.</p>', 'p'],
        ];
        foreach ($nodes as [$startLine, $content, $type]) {
            $this->upsertNode($admin, $this->nodeRow($book, $startLine, $content, $type));
        }

        // Footnote definition + its sub-book library row (footnote sub-books
        // without a library row are the RLS chicken-and-egg 500 documented in
        // memory/paste-subbook-rls-chicken-egg — seed both). preview_nodes is
        // REQUIRED: the container's initial render uses it; when it's missing
        // the loader bootstraps an EMPTY sub-book node and syncs it to the
        // backend, poisoning the fixture.
        $subBookNodeId = $subBookId . '_e2efix_1';
        $subBookNodeContent = '<p id="1" data-node-id="' . $subBookNodeId . '">E2E fixture footnote definition with <a href="https://example.org/fn-link">a link inside the container</a>.</p>';
        $admin->table('footnotes')->updateOrInsert(
            ['book' => $book, 'footnoteId' => $footnoteId],
            [
                'book' => $book,
                'footnoteId' => $footnoteId,
                'sub_book_id' => $subBookId,
                'content' => '<a fn-count-id="' . $fnCount . '" id="' . $footnoteId . '"></a><p>E2E fixture footnote definition.</p>',
                'preview_nodes' => json_encode([[
                    'book' => $subBookId,
                    'content' => $subBookNodeContent,
                    'node_id' => $subBookNodeId,
                    'chunk_id' => 0,
                    'footnotes' => [],
                    'startLine' => 1,
                    'hypercites' => [],
                    'hyperlights' => [],
                ]]),
                'is_citation' => false,
                'created_at' => now(),
                'updated_at' => now(),
            ]
        );
        $admin->table('library')->updateOrInsert(['book' => $subBookId], $this->libraryRow($user, $subBookId, 'E2E A11y Fixture — footnote 1', [
            'has_nodes' => true,
        ]));
        // The container renders the footnote as a SUB-BOOK (nodes where
        // book = sub_book_id) — the full node mirrors preview_nodes above.
        $this->upsertNode($admin, array_merge(
            $this->nodeRow($subBookId, 1, $subBookNodeContent),
            ['node_id' => $subBookNodeId]
        ));

        $this->line("  ✓ {$book}");
    }
}
