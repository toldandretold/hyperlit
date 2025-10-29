<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use Carbon\Carbon;
use App\Models\PgLibrary;

class UserHomeServerController extends Controller
{
    /**
     * Show user's homepage (for subdomain routing)
     */
    public function show(string $username)
    {
        // Check if user exists
        $user = \App\Models\User::where('name', $username)->first();

        if (!$user) {
            abort(404, 'User not found');
        }

        // Generate user's library books
        $isOwner = Auth::check() && Auth::user()->name === $username;

        // Always generate public book
        $this->generateUserHomeBook($username, $isOwner, 'public');

        // Only generate private book if user is owner
        if ($isOwner) {
            $this->generateUserHomeBook($username, $isOwner, 'private');
        }

        // Fetch library record for title and bio
        $libraryRecord = DB::table('library')
            ->where('book', $username)
            ->first();

        $title = $libraryRecord ? ($libraryRecord->title ?? "{$username}'s library") : "{$username}'s library";
        $bio = $libraryRecord ? ($libraryRecord->note ?? '') : '';

        // Return user.blade.php with user page data
        return view('user', [
            'pageType' => 'user',
            'book' => $username,
            'username' => $username,
            'isOwner' => $isOwner,
            'libraryTitle' => $title,
            'libraryBio' => $bio,
        ]);
    }

    public function generateUserHomeBook(string $username, bool $currentUserIsOwner = null, string $visibility = 'public'): array
    {
        // Determine book name based on visibility
        $bookName = $visibility === 'private' ? $username . 'Private' : $username;

        $records = DB::table('library')
            ->select(['book', 'title', 'author', 'year', 'publisher', 'journal', 'bibtex', 'created_at'])
            ->where('creator', $username)
            ->where('book', '!=', $username)
            ->where('book', '!=', $username . 'Private')
            ->where('visibility', $visibility)
            ->orderByDesc('created_at')
            ->get();

        // Preserve existing highlights and cites
        $oldChunks = DB::table('node_chunks')->where('book', $bookName)->get()->keyBy('node_id');

        DB::table('library')->updateOrInsert(
            ['book' => $bookName],
            [
                'author' => null, 'title' => $username . "'s library", 'visibility' => $visibility, 'listed' => false, 'creator' => $username, 'creator_token' => null,
                'raw_json' => json_encode(['type' => 'user_home', 'username' => $username, 'visibility' => $visibility]),
                'timestamp' => round(microtime(true) * 1000), 'updated_at' => now(), 'created_at' => now(),
            ]
        );

        DB::table('node_chunks')->where('book', $bookName)->delete();

        $chunks = [];

        $positionId = 100;
        // Use passed parameter if provided, otherwise check current auth state
        $isOwner = $currentUserIsOwner !== null ? $currentUserIsOwner : (Auth::check() && Auth::user()->name === $username);

        foreach ($records as $i => $record) {
            $newChunk = $this->generateLibraryCardChunk($record, $bookName, $positionId, $isOwner, false, $i);
            if(isset($oldChunks[$record->book])) {
                $newChunk['hypercites'] = $oldChunks[$record->book]->hypercites;
                $newChunk['hyperlights'] = $oldChunks[$record->book]->hyperlights;
            }
            $chunks[] = $newChunk;
            $positionId++;
        }

        if ($records->isEmpty()) {
             $chunks[] = $this->generateLibraryCardChunk(null, $bookName, 1, $isOwner, true, 0, $visibility);
        }

        foreach (array_chunk($chunks, 500) as $batch) {
            DB::table('node_chunks')->insert($batch);
        }

        return ['success' => true, 'count' => count($chunks)];
    }

    public function addBookToUserPage(string $username, PgLibrary $bookRecord)
    {
        // Determine which book to update based on visibility
        $visibility = $bookRecord->visibility ?? 'public';
        $bookName = $visibility === 'private' ? $username . 'Private' : $username;

        $minStartLine = DB::table('node_chunks')
            ->where('book', $bookName)
            ->where('startLine', '>', 0)
            ->min('startLine');

        $newStartLine = ($minStartLine !== null) ? $minStartLine - 1 : 100;

        if ($newStartLine < 1) {
            $this->generateUserHomeBook($username, null, $visibility);
        } else {
            // For addBookToUserPage, always use current auth state
            $isOwner = Auth::check() && Auth::user()->name === $username;
            $chunk = $this->generateLibraryCardChunk($bookRecord, $bookName, $newStartLine, $isOwner, false, -1);
            DB::table('node_chunks')->insert($chunk);
            DB::table('library')->where('book', $bookName)->update(['timestamp' => round(microtime(true) * 1000)]);
        }

        return ['success' => true];
    }

    public function updateBookOnUserPage(string $username, PgLibrary $bookRecord)
    {
        // Determine which book to update based on visibility
        $visibility = $bookRecord->visibility ?? 'public';
        $bookName = $visibility === 'private' ? $username . 'Private' : $username;

        $chunkToUpdate = DB::table('node_chunks')
            ->where('book', $bookName)
            ->where('node_id', $bookRecord->book)
            ->first();

        if ($chunkToUpdate) {
            $isOwner = Auth::check() && Auth::user()->name === $username;
            $newContent = $this->generateLibraryCardHtml($bookRecord, $chunkToUpdate->startLine, $isOwner);
            $newRawJson = json_encode([
                'original_book' => $bookRecord->book, 'position_type' => 'user_home', 'position_id' => $chunkToUpdate->startLine,
                'bibtex' => $bookRecord->bibtex, 'title' => $bookRecord->title ?? null, 'author' => $bookRecord->author ?? null, 'year' => $bookRecord->year ?? null,
            ]);
            $newPlainText = strip_tags($this->generateCitationHtml($bookRecord));

            DB::table('node_chunks')->where('id', $chunkToUpdate->id)->update([
                'content' => $newContent,
                'raw_json' => $newRawJson,
                'plainText' => $newPlainText,
                'updated_at' => now(),
            ]);

            DB::table('library')
                ->where('book', $bookName)
                ->update(['timestamp' => round(microtime(true) * 1000)]);
        }

        return ['success' => true];
    }

    private function generateLibraryCardChunk($record, string $bookName, int $positionId, bool $isOwner, bool $isEmpty = false, int $index = 0, string $visibility = 'public')
    {
        $now = Carbon::now();

        if ($isEmpty || !$record) {
            $emptyMessage = $visibility === 'private'
                ? '<em>no private hypertext</em>'
                : '<em>no public hypertext</em>';

            return [
                'raw_json' => json_encode(['original_book' => null, 'position_type' => 'user_home', 'position_id' => 1, 'empty' => true]),
                'book' => $bookName, 'chunk_id' => 0, 'startLine' => 1, 'node_id' => $bookName . '_empty_node',
                'footnotes' => null, 'hypercites' => null, 'hyperlights' => null,
                'content' => '<p class="libraryCard" id="1" data-node-id="empty_card">' . $emptyMessage . '</p>',
                'plainText' => strip_tags($emptyMessage), 'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
            ];
        }

        $content = $this->generateLibraryCardHtml($record, $positionId, $isOwner);

        return [
            'raw_json' => json_encode([
                'original_book' => $record->book, 'position_type' => 'user_home', 'position_id' => $positionId,
                'bibtex' => $record->bibtex, 'title' => $record->title ?? null, 'author' => $record->author ?? null, 'year' => $record->year ?? null,
            ]),
            'book' => $bookName,
            'chunk_id' => ($index < 0) ? 0 : floor($index / 100),
            'startLine' => $positionId,
            'node_id' => $record->book,
            'footnotes' => null, 'hypercites' => null, 'hyperlights' => null,
            'content' => $content,
            'plainText' => strip_tags($this->generateCitationHtml($record)),
            'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
        ];
    }

    private function generateLibraryCardHtml($record, int $positionId, bool $isOwner): string
    {
        $nodeId = $record->book;
        $citationHtml = $this->generateCitationHtml($record);
        $content = '<p class="libraryCard" id="' . $positionId . '" data-node-id="' . $nodeId . '">' . $citationHtml . '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a>';

        if ($isOwner) {
            $content .= '<a href="#" class="delete-book" data-book="' . $record->book . '" title="Delete" aria-label="Delete">'
                . '<svg id="svgDeleter" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
                . '<path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
                . '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
                . '</svg></a>';
        }
        $content .= '</p>';
        return $content;
    }

    private function generateCitationHtml($record)
    {
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
