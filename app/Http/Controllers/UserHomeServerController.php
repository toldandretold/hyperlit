<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Carbon\Carbon;

class UserHomeServerController extends Controller
{
    public function generateUserHomeBook(string $username): array
    {
        // Fetch all books created by this user
        $records = DB::table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'updated_at'])
            ->where('creator', $username)
            ->orderByDesc('updated_at')
            ->get();

        // Ensure a library entry exists for this pseudo-book
        $now = Carbon::now();
        DB::table('library')->updateOrInsert(
            ['book' => $username],
            [
                'author' => 'hyperlit',
                'title' => $username . " — My Books",
                'raw_json' => json_encode([
                    'type' => 'user_home',
                    'username' => $username,
                ]),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => $now,
                'created_at' => $now,
            ]
        );

        // Clear existing chunks for this user-book
        DB::table('node_chunks')->where('book', $username)->delete();

        // Build simple citation list similar to most-recent style
        $chunks = [];
        $chunkId = 1;

        foreach ($records as $record) {
            $citationHtml = $this->generateCitationHtml($record);
            $href = '/' . $record->book;
            $lineHtml = "<p><a href=\"{$href}\">{$citationHtml}</a></p>";

            $chunks[] = [
                'book' => $username,
                'chunk_id' => $chunkId,
                'startLine' => (float) ($chunkId * 10),
                'content' => $lineHtml,
                'plainText' => strip_tags($citationHtml),
                'type' => 'p',
                'footnotes' => json_encode([]),
                'hyperlights' => json_encode([]),
                'hypercites' => json_encode([]),
                'raw_json' => json_encode(['source' => 'user_home', 'book' => $record->book]),
                'created_at' => $now,
                'updated_at' => $now,
            ];
            $chunkId++;
        }

        // Ensure at least one chunk so API consumers don't 404 on empty lists
        if (empty($chunks)) {
            $chunks[] = [
                'book' => $username,
                'chunk_id' => 1,
                'startLine' => 10.0,
                'content' => '<p>No books at the moment</p>',
                'plainText' => 'No books at the moment',
                'type' => 'p',
                'footnotes' => json_encode([]),
                'hyperlights' => json_encode([]),
                'hypercites' => json_encode([]),
                'raw_json' => json_encode(['source' => 'user_home', 'empty' => true]),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        // Insert in batches
        foreach (array_chunk($chunks, 500) as $batch) {
            DB::table('node_chunks')->insert($batch);
        }

        return [
            'success' => true,
            'count' => count($chunks),
        ];
    }

    private function generateCitationHtml($record)
    {
        // Basic fallback similar to HomePageServerController's logic
        $hasTitle = !empty($record->title);
        $hasAuthor = !empty($record->author);
        $hasYear = !empty($record->year);
        $hasPublisher = !empty($record->publisher);
        $hasJournal = !empty($record->journal);

        if (!$hasTitle && !$hasAuthor && !$hasYear && !$hasPublisher && !$hasJournal) {
            return 'Anon., <em>Unreferenced</em>';
        }

        $html = '';

        if ($hasAuthor) {
            $html .= '<strong>' . e($record->author) . '</strong>. ';
        } else {
            $html .= '<strong>Anon.</strong> ';
        }

        if ($hasTitle) {
            if ($hasJournal) {
                $html .= '"' . e($record->title) . '." ';
            } else {
                $html .= '<em>' . e($record->title) . '</em>. ';
            }
        } else {
            $html .= '<em>Unreferenced</em>. ';
        }

        if ($hasJournal) {
            $html .= '<em>' . e($record->journal) . '</em>. ';
        }
        if ($hasPublisher && !$hasJournal) {
            $html .= e($record->publisher) . '. ';
        }
        if ($hasYear) {
            $html .= e($record->year);
        }

        $html = preg_replace('/\s+/', ' ', $html);
        $html = trim($html);
        if (!empty($html) && !in_array(substr($html, -1), ['.', '!', '?'])) {
            $html .= '.';
        }
        return $html;
    }
}
