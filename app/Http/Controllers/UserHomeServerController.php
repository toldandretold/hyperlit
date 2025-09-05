<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
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
                'private' => true,
                // Set ownership so server-side delete checks can authorize
                'creator' => $username,
                'creator_token' => null,
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

        // Build libraryCard list using the same structure as homepage pseudo-books
        $chunks = [];
        $positionId = 1;

        $isOwner = Auth::check() && Auth::user()->name === $username;

        foreach ($records as $record) {
            $citationHtml = $this->generateCitationHtml($record);
            $content = '<p class="libraryCard" id="' . $positionId . '">' .
                $citationHtml .
                '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a>';

            if ($isOwner) {
                $content .= '<a href="#" class="delete-book" data-book="' . $record->book . '" title="Delete" aria-label="Delete">'
                    . '<svg id="svgDeleter" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
                    . '<path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
                    . '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
                    . '</svg>'
                    . '</a>';
            }

            $content .= '</p>';

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
                'book' => $username,
                'chunk_id' => floor(($positionId - 1) / 100),
                'startLine' => $positionId,
                'footnotes' => null,
                'hypercites' => null,
                'hyperlights' => null,
                'content' => $content,
                'plainText' => strip_tags($citationHtml),
                'type' => 'p',
                'created_at' => $now,
                'updated_at' => $now,
            ];
            $positionId++;
        }

        // Ensure at least one chunk so API consumers don't 404 on empty lists
        if (empty($chunks)) {
            $chunks[] = [
                'raw_json' => json_encode([
                    'original_book' => null,
                    'position_type' => 'user_home',
                    'position_id' => 1,
                    'empty' => true,
                ]),
                'book' => $username,
                'chunk_id' => 0,
                'startLine' => 1,
                'footnotes' => null,
                'hypercites' => null,
                'hyperlights' => null,
                'content' => '<p class="libraryCard" id="1">No books at the moment</p>',
                'plainText' => 'No books at the moment',
                'type' => 'p',
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
