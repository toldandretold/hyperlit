<?php

namespace App\Console\Commands;

use App\Http\Controllers\UserHomeServerController;
use App\Services\ShelfCacheInvalidator;
use App\Support\UserHomeBookNames;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Seed the deterministic shelves + member books the e2e user-page suite
 * relies on (tests/e2e/specs/user/). Idempotent — safe to re-run any time,
 * and the suite's afterAll re-runs it to undo destructive phases (the
 * pencil-panel test toggles pill_shelves on the live row).
 *
 *   php artisan e2e:seed-user-shelves
 *
 * Seeds, owned by the e2e test user (E2E_USER_EMAIL / --email):
 *   - three shelves: two PUBLIC (Alpha, Beta — they render as visitor
 *     shelf pills) and one PRIVATE (Gamma — reachable only via the owner's
 *     + picker), each holding the three member books;
 *   - three small PUBLIC books (cards must show for anonymous visitors);
 *   - page_settings.pill_shelves reset to [Alpha, Beta];
 *   - home books regenerated + every shelf/sorted render cache flushed, so
 *     each run starts deterministic.
 *
 * Uses the BYPASSRLS `pgsql_admin` connection (same rationale as
 * SeedE2eFixtures).
 */
class SeedE2eUserShelves extends Command
{
    protected $signature = 'e2e:seed-user-shelves {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed the shelves + member books used by the e2e user-page suite (idempotent)';

    public const SHELVES = [
        ['name' => 'E2E Shelf Alpha', 'slug' => 'e2e-shelf-alpha', 'visibility' => 'public'],
        ['name' => 'E2E Shelf Beta', 'slug' => 'e2e-shelf-beta', 'visibility' => 'public'],
        ['name' => 'E2E Shelf Gamma', 'slug' => 'e2e-shelf-gamma', 'visibility' => 'private'],
    ];

    public const BOOKS = [
        ['book' => 'book_e2e_shelf_alborz', 'title' => 'E2E Alborz Mountains Reader', 'author' => 'Aardvark, Alice'],
        ['book' => 'book_e2e_shelf_borges', 'title' => 'E2E Borges Compendium', 'author' => 'Middleton, Mona'],
        ['book' => 'book_e2e_shelf_zanzibar', 'title' => 'E2E Zanzibar Chronicle', 'author' => 'Zebra, Zed'],
    ];

    public function handle(): int
    {
        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');

        $user = $admin->table('users')->where('email', $email)->first();
        if (!$user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");
            return self::FAILURE;
        }

        $bookIds = $this->seedBooks($admin, $user);
        $shelfIds = $this->seedShelves($admin, $user, $bookIds);
        $this->resetPillShelves($admin, $user, [$shelfIds['e2e-shelf-alpha'], $shelfIds['e2e-shelf-beta']]);

        // Deterministic feeds: rebuild the home books so every seeded book has
        // its card, and flush every render cache (shelf + sorted variants).
        $controller = app(UserHomeServerController::class);
        $controller->generateUserHomeBook($user->name, true, 'public');
        $controller->generateUserHomeBook($user->name, true, 'private');
        $controller->generateAllUserHomeBook($user->name);

        $invalidator = new ShelfCacheInvalidator();
        foreach ($shelfIds as $id) {
            $invalidator->flush($id);
        }
        $invalidator->flushUserHomeSortedVariants($user->name);

        $this->info('Seeded shelves: ' . implode(', ', array_keys($shelfIds)) . ' with books: ' . implode(', ', $bookIds));
        foreach ($shelfIds as $slug => $id) {
            $this->line("  {$slug}: {$id}");
        }

        return self::SUCCESS;
    }

    /** @return array<string> */
    private function seedBooks($admin, object $user): array
    {
        $ids = [];
        foreach (self::BOOKS as $i => $spec) {
            $book = $spec['book'];
            $admin->table('library')->updateOrInsert(['book' => $book], [
                'book' => $book,
                'title' => $spec['title'],
                'author' => $spec['author'],
                'creator' => $user->name,
                'creator_token' => $user->user_token,
                'visibility' => 'public',
                'listed' => false,
                'license' => 'all-rights-reserved',
                'has_nodes' => true,
                'encrypted' => false,
                'timestamp' => (string) (int) (microtime(true) * 1000),
                'raw_json' => json_encode(['book' => $book, 'title' => $spec['title']]),
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            // RESET nodes for determinism (see SeedE2eFixtures for rationale).
            $admin->table('nodes')->where('book', $book)->delete();
            foreach ([[100, '<h1 id="100" data-node-id="' . $book . '_e2efix_100">' . e($spec['title']) . '</h1>', 'h1'],
                      [200, '<p id="200" data-node-id="' . $book . '_e2efix_200">Deterministic e2e shelf-member content, book ' . ($i + 1) . '.</p>', 'p']] as [$startLine, $content, $type]) {
                $admin->table('nodes')->updateOrInsert(
                    ['book' => $book, 'startLine' => $startLine],
                    [
                        'book' => $book,
                        'startLine' => $startLine,
                        'chunk_id' => 0,
                        'node_id' => "{$book}_e2efix_{$startLine}",
                        'type' => $type,
                        'content' => $content,
                        'plainText' => trim(strip_tags($content)),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]
                );
            }
            $ids[] = $book;
        }

        return $ids;
    }

    /** @return array<string, string> slug => shelf uuid */
    private function seedShelves($admin, object $user, array $bookIds): array
    {
        $shelfIds = [];
        foreach (self::SHELVES as $spec) {
            $existing = $admin->table('shelves')
                ->where('creator', $user->name)
                ->where('slug', $spec['slug'])
                ->first();

            if ($existing) {
                $admin->table('shelves')->where('id', $existing->id)->update([
                    'name' => $spec['name'],
                    'visibility' => $spec['visibility'],
                    'default_sort' => 'recent',
                    'updated_at' => now(),
                ]);
                $shelfId = $existing->id;
            } else {
                $shelfId = (string) \Illuminate\Support\Str::uuid();
                $admin->table('shelves')->insert([
                    'id' => $shelfId,
                    'creator' => $user->name,
                    'creator_token' => null,
                    'name' => $spec['name'],
                    'slug' => $spec['slug'],
                    'visibility' => $spec['visibility'],
                    'default_sort' => 'recent',
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }

            foreach ($bookIds as $book) {
                $admin->table('shelf_items')->updateOrInsert(
                    ['shelf_id' => $shelfId, 'book' => $book],
                    ['shelf_id' => $shelfId, 'book' => $book, 'added_at' => now()]
                );
            }

            $shelfIds[$spec['slug']] = $shelfId;
        }

        return $shelfIds;
    }

    private function resetPillShelves($admin, object $user, array $publicShelfIds): void
    {
        $sanitized = UserHomeBookNames::sanitize($user->name);
        $row = $admin->table('library')->where('book', $sanitized)->first(['page_settings']);
        $settings = $row && $row->page_settings ? (json_decode($row->page_settings, true) ?: []) : [];
        $settings['pill_shelves'] = array_values($publicShelfIds);

        $admin->table('library')
            ->where('book', $sanitized)
            ->update(['page_settings' => json_encode($settings)]);
    }
}
