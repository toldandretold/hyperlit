<?php

namespace App\Services;

use Carbon\Carbon;

class LibraryCardGenerator
{
    /**
     * Generate a library card chunk array ready for DB insertion.
     */
    public function generateLibraryCardChunk($record, string $bookName, int $positionId, bool $isOwner, bool $isEmpty = false, int $index = 0, string $visibility = 'public', bool $locked = false): array
    {
        $now = Carbon::now();

        if ($isEmpty || !$record) {
            $emptyMessage = $visibility === 'private'
                ? '<em>no private hypertext</em>'
                : '<em>no public hypertext</em>';

            $emptyNodeId = $bookName . '_empty_card';
            return [
                'raw_json' => json_encode(['original_book' => null, 'position_type' => 'user_home', 'position_id' => 1, 'empty' => true]),
                'book' => $bookName, 'chunk_id' => 0, 'startLine' => 1, 'node_id' => $emptyNodeId,
                'footnotes' => null,
                'content' => '<p class="libraryCard" id="1" data-node-id="' . $emptyNodeId . '">' . $emptyMessage . '</p>',
                'plainText' => strip_tags($emptyMessage), 'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
            ];
        }

        $nodeId = $bookName . '_' . $record->book . '_card';
        $content = $this->generateLibraryCardHtml($record, $positionId, $isOwner, $nodeId, $locked);

        return [
            'raw_json' => json_encode([
                'original_book' => $record->book, 'position_type' => 'user_home', 'position_id' => $positionId,
                'bibtex' => $record->bibtex ?? null, 'title' => $record->title ?? null, 'author' => $record->author ?? null, 'year' => $record->year ?? null,
            ]),
            'book' => $bookName,
            'chunk_id' => ($index < 0) ? 0 : floor($index / 100),
            'startLine' => $positionId,
            'node_id' => $nodeId,
            'footnotes' => null,
            'content' => $content,
            'plainText' => strip_tags($this->generateCitationHtml($record)),
            'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
        ];
    }

    /**
     * Generate the HTML for a library card.
     * Uses a "..." action button instead of a trash icon.
     */
    public function generateLibraryCardHtml($record, int $positionId, bool $isOwner, string $nodeId, bool $locked = false): string
    {
        $citationHtml = $this->generateCitationHtml($record);
        $lockedClass = $locked ? ' libraryCard-locked' : '';
        $content = '<p class="libraryCard' . $lockedClass . '" id="' . $positionId . '" data-node-id="' . $nodeId . '">' . $citationHtml;

        if ($locked) {
            $content .= '<span class="locked-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg></span>';
        } else {
            $content .= '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a>';
        }

        if ($isOwner) {
            $content .= '<a href="#" class="book-actions" data-book="' . $record->book . '" title="Actions" aria-label="Actions">'
                . '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
                . '<circle cx="12" cy="5" r="1.5"/>'
                . '<circle cx="12" cy="12" r="1.5"/>'
                . '<circle cx="12" cy="19" r="1.5"/>'
                . '</svg></a>';
        }
        $content .= '</p>';
        return $content;
    }

    /**
     * Generate citation HTML from a library record.
     */
    public function generateCitationHtml($record): string
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
