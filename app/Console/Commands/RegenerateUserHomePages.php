<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\User;
use App\Http\Controllers\UserHomeServerController;
use Illuminate\Support\Facades\DB;

class RegenerateUserHomePages extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'users:regenerate-home-pages';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Regenerate all user home pages with the new incremental logic.';

    /**
     * Execute the console command.
     * Uses admin connection to read user list (users table is RLS-protected),
     * but user home page writes use type='user_home' RLS exception.
     */
    public function handle()
    {
        $this->info('Starting regeneration of all user home pages...');

        // Need admin connection to read full users list (users table has RLS)
        $users = DB::connection('pgsql_admin')->table('users')->get();

        foreach ($users as $user) {
            $username = $user->name;
            $userToken = $user->user_token;
            $this->line("Processing user: {$username}");

            try {
                $this->regenerateUserHomePage($username, $userToken);
                $this->info("  -> Successfully regenerated page for {$username}");
            } catch (\Exception $e) {
                $this->error("  -> Failed to regenerate page for {$username}: " . $e->getMessage());
            }
        }

        $this->info('All user home pages have been regenerated.');
        return 0;
    }

    /**
     * Regenerate a user's home page.
     * Uses admin connection for database operations since this runs from CLI without session context.
     * creator_token is null for user home pages (RLS uses type='user_home' exception).
     */
    private function regenerateUserHomePage(string $username, ?string $userToken): void
    {
        $sanitizedUsername = str_replace(' ', '', $username);
        $bookName = $sanitizedUsername;

        // Get user's public books
        $records = DB::connection('pgsql_admin')->table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at'])
            ->where('creator', $username)
            ->where('book', '!=', $sanitizedUsername)
            ->where('book', '!=', $sanitizedUsername . 'Private')
            ->where('visibility', 'public')
            ->orderByDesc('created_at')
            ->get();

        // Update or create library entry
        // creator_token = null for user home pages (RLS uses type='user_home' exception)
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $bookName],
            [
                'author' => null,
                'title' => $username . "'s library",
                'visibility' => 'public',
                'listed' => false,
                'creator' => $username,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_home', 'username' => $username, 'sanitized_username' => $sanitizedUsername, 'visibility' => 'public']),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        // Delete existing nodes
        DB::connection('pgsql_admin')->table('nodes')->where('book', $bookName)->delete();

        // Create new node entries
        $chunks = [];
        $now = now();
        $positionId = 100;

        foreach ($records as $i => $record) {
            $nodeId = $bookName . '_' . $record->book . '_card';
            $chunks[] = [
                'raw_json' => json_encode([
                    'original_book' => $record->book,
                    'position_type' => 'user_home',
                    'position_id' => $positionId,
                    'bibtex' => $record->bibtex,
                    'title' => $record->title ?? null,
                    'author' => $record->author ?? null,
                    'year' => $record->year ?? null,
                ]),
                'book' => $bookName,
                'chunk_id' => floor($i / 100),
                'startLine' => $positionId,
                'node_id' => $nodeId,
                'footnotes' => null,
                'content' => $this->generateCardHtml($record, $positionId, $nodeId),
                'plainText' => $this->generatePlainText($record),
                'type' => 'p',
                'created_at' => $now,
                'updated_at' => $now,
            ];
            $positionId++;
        }

        if (empty($chunks)) {
            $emptyNodeId = $bookName . '_empty_card';
            $chunks[] = [
                'raw_json' => json_encode(['original_book' => null, 'position_type' => 'user_home', 'position_id' => 1, 'empty' => true]),
                'book' => $bookName,
                'chunk_id' => 0,
                'startLine' => 1,
                'node_id' => $emptyNodeId,
                'footnotes' => null,
                'content' => '<p class="libraryCard" id="1" data-node-id="' . $emptyNodeId . '"><em>no public hypertext</em></p>',
                'plainText' => 'no public hypertext',
                'type' => 'p',
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }
    }

    private function generateCardHtml($record, int $positionId, string $nodeId): string
    {
        $citation = $this->generateCitation($record);
        return '<p class="libraryCard" id="' . $positionId . '" data-node-id="' . $nodeId . '">' . $citation . '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a></p>';
    }

    private function generatePlainText($record): string
    {
        return strip_tags($this->generateCitation($record));
    }

    private function generateCitation($record): string
    {
        $html = '';
        $html .= !empty($record->author) ? '<strong>' . e($record->author) . '</strong>. ' : '<strong>Anon.</strong> ';
        $html .= !empty($record->title) ? '<em>' . e($record->title) . '</em>. ' : '<em>Unreferenced</em>. ';
        $html .= !empty($record->year) ? e($record->year) : '';
        $html = trim(preg_replace('/\s+/', ' ', $html));
        if (!empty($html) && !in_array(substr($html, -1), ['.', '!', '?'])) {
            $html .= '.';
        }
        return $html;
    }
}
