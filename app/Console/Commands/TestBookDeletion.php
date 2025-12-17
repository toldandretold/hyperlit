<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use App\Services\BookDeletionService;
use App\Http\Controllers\UserHomeServerController;

class TestBookDeletion extends Command
{
    protected $signature = 'test:book-deletion {username}';
    protected $description = 'Test that book deletion properly removes cards from user home pages';

    public function handle()
    {
        $username = $this->argument('username');
        $sanitized = str_replace(' ', '', $username);
        $testBookId = 'test_deletion_' . time();

        $this->info("Testing book deletion for user: {$username}");
        $this->line("Sanitized username: {$sanitized}");
        $this->line("Test book ID: {$testBookId}");

        // 1. Create a test library entry
        $this->info("\n1. Creating test book...");
        DB::table('library')->insert([
            'book' => $testBookId,
            'title' => 'Test Deletion Book',
            'creator' => $username,
            'visibility' => 'private',
            'timestamp' => round(microtime(true) * 1000),
            'raw_json' => json_encode(['test' => true]),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $this->line("   Created library entry: {$testBookId}");

        // 2. Add card to user home page
        $this->info("\n2. Adding card to user home page...");
        $controller = new UserHomeServerController();
        $book = DB::table('library')->where('book', $testBookId)->first();
        $pgLibrary = new \App\Models\PgLibrary((array) $book);
        $pgLibrary->exists = true;
        $controller->addBookToUserPage($username, $pgLibrary);

        // 3. Verify card exists
        $privateBook = $sanitized . 'Private';
        $expectedNodeId = $privateBook . '_' . $testBookId . '_card';

        $cardBefore = DB::table('nodes')
            ->where('book', $privateBook)
            ->where('node_id', $expectedNodeId)
            ->first();

        if ($cardBefore) {
            $this->info("   ✓ Card created with node_id: {$expectedNodeId}");
            $this->line("     startLine: {$cardBefore->startLine}");
        } else {
            $this->error("   ✗ Card NOT found! Expected node_id: {$expectedNodeId}");
            $this->cleanup($testBookId);
            return 1;
        }

        // 4. Delete the book
        $this->info("\n3. Deleting test book...");
        $service = new BookDeletionService();
        $stats = $service->deleteBook($testBookId);
        $this->line("   Deletion stats: " . json_encode($stats));

        // 5. Verify card was deleted
        $this->info("\n4. Verifying card was deleted...");
        $cardAfter = DB::table('nodes')
            ->where('book', $privateBook)
            ->where('node_id', $expectedNodeId)
            ->first();

        if (!$cardAfter) {
            $this->info("   ✓ Card successfully deleted!");
        } else {
            $this->error("   ✗ Card still exists! Deletion failed.");
            $this->cleanup($testBookId);
            return 1;
        }

        // 6. Cleanup
        $this->info("\n5. Cleanup...");
        $this->cleanup($testBookId);

        $this->info("\n✅ All tests passed!");
        return 0;
    }

    private function cleanup(string $bookId): void
    {
        DB::table('library')->where('book', $bookId)->delete();
        DB::table('nodes')->where('book', $bookId)->delete();
        $this->line("   Cleaned up test data");
    }
}
