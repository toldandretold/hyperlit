<?php

namespace App\Services;

use Carbon\Carbon;

class LibraryCardGenerator
{
    /** The asterisked E2EE padlock, 14px inline (see resources/js/e2ee/ui/lockIcon.ts). */
    private const ENCRYPTED_LOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><text x="7.5" y="20" font-size="10" font-weight="bold" fill="var(--color-danger)" stroke="none" text-anchor="middle" font-family="monospace">*</text><text x="12" y="20" font-size="10" font-weight="bold" fill="var(--color-danger)" stroke="none" text-anchor="middle" font-family="monospace">*</text><text x="16.5" y="20" font-size="10" font-weight="bold" fill="var(--color-danger)" stroke="none" text-anchor="middle" font-family="monospace">*</text></svg>';

    /**
     * Generate a library card chunk array ready for DB insertion.
     */
    public function generateLibraryCardChunk($record, string $bookName, int $positionId, bool $isOwner, bool $isEmpty = false, int $index = 0, string $visibility = 'public', bool $locked = false, bool $isPrivate = false): array
    {
        $now = Carbon::now();

        if ($isEmpty || !$record) {
            $emptyMessage = $visibility === 'private'
                ? '<em>no private hypertext</em>'
                : '<em>no public hypertext</em>';

            $emptyNodeId = $bookName . '_empty_card';
            return [
                'book' => $bookName, 'chunk_id' => 0, 'startLine' => 1, 'node_id' => $emptyNodeId,
                'footnotes' => null,
                'content' => '<p class="libraryCard" id="1" data-node-id="' . $emptyNodeId . '">' . $emptyMessage . '</p>',
                'plainText' => strip_tags($emptyMessage), 'type' => 'p', 'created_at' => $now, 'updated_at' => $now,
            ];
        }

        $nodeId = $bookName . '_' . $record->book . '_card';
        $content = $this->generateLibraryCardHtml($record, $positionId, $isOwner, $nodeId, $locked, $isPrivate);

        return [
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
    public function generateLibraryCardHtml($record, int $positionId, bool $isOwner, string $nodeId, bool $locked = false, bool $isPrivate = false): string
    {
        $citationHtml = $this->generateCitationHtml($record);
        $classes = 'libraryCard';
        if ($locked) $classes .= ' libraryCard-locked';
        if ($isPrivate) $classes .= ' libraryCard-private';
        // E2EE (docs/e2ee.md): the card renders a generic label (title/author are
        // ciphertext server-side); the owner's client swaps the real title in from
        // its local plaintext store. Book stays openable — the reader gate unlocks.
        if (!empty($record->encrypted)) $classes .= ' libraryCard-encrypted';
        $content = '<p class="' . $classes . '" id="' . $positionId . '" data-node-id="' . $nodeId . '">'
            . '<span class="card-citation">' . $citationHtml . '</span>';

        if ($locked) {
            $content .= '<span class="locked-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg></span>';
        } else {
            $content .= '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a>';
        }

        if ($isPrivate && !$locked) {
            $content .= '<span class="private-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg></span>';
        }

        $content .= '<a href="#" class="book-actions" data-book="' . $record->book . '" title="Actions" aria-label="Actions">'
            . '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
            . '<circle cx="12" cy="5" r="1.5"/>'
            . '<circle cx="12" cy="12" r="1.5"/>'
            . '<circle cx="12" cy="19" r="1.5"/>'
            . '</svg></a>';
        $content .= '</p>';
        return $content;
    }

    /**
     * Generate citation HTML from a library record.
     * Precedence: E2EE lock label → parsed bibtex → structured fields.
     * The E2EE check MUST stay first: an encrypted book's bibtex is ciphertext.
     */
    public function generateCitationHtml($record): string
    {
        // E2EE: never render ciphertext metadata — generic label instead
        // (the owner's client swaps in the real title from local plaintext).
        // PHP copy of the asterisked padlock in resources/js/e2ee/ui/lockIcon.ts —
        // keep them visually in sync.
        if (!empty($record->encrypted)) {
            return self::ENCRYPTED_LOCK_SVG . ' <em>Encrypted book</em>';
        }

        if (!empty($record->bibtex)) {
            $bibtexHtml = $this->parseBibtexToHtml($record->bibtex);
            if ($bibtexHtml !== '') {
                return $bibtexHtml;
            }
        }

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
            $html .= '<strong>' . e($this->anonymizeIfNeeded($record->author)) . '</strong>. ';
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

    /**
     * Parse a raw BibTeX entry into citation HTML. Empty string when the
     * entry can't be parsed (caller falls back to structured fields).
     * Public so the escaping/formatting contract is unit-testable directly.
     */
    public function parseBibtexToHtml(string $bibtex): string
    {
        if (trim($bibtex) === '') {
            return '';
        }

        $parsed = $this->parseBibtexEntry($bibtex);
        if (empty($parsed)) {
            return '';
        }

        return $this->generateHtmlCitation($parsed);
    }

    private function parseBibtexEntry(string $bibtex): ?array
    {
        $bibtex = trim($bibtex);

        if (!preg_match('/@(\w+)\s*\{\s*([^,]+)\s*,/', $bibtex, $matches)) {
            return null;
        }

        $entryType = strtolower($matches[1]);
        $key = trim($matches[2]);

        $fields = [];
        preg_match_all('/(\w+)\s*=\s*[{"](.*?)["}](?=\s*,|\s*})/s', $bibtex, $fieldMatches, PREG_SET_ORDER);
        foreach ($fieldMatches as $match) {
            $fields[strtolower(trim($match[1]))] = trim($match[2]);
        }

        return [
            'type' => $entryType,
            'key' => $key,
            'fields' => $fields,
        ];
    }

    /**
     * Field values come from user-supplied bibtex — every interpolation is
     * escaped with e(). Formatting mirrors the JS bibtexProcessor.js output.
     */
    private function generateHtmlCitation(array $parsed): string
    {
        $fields = $parsed['fields'];
        $type = $parsed['type'];

        $get = fn (string $field): string => $fields[$field] ?? '';

        $html = '';

        if ($author = $get('author')) {
            $html .= '<strong>' . e($this->anonymizeIfNeeded($author)) . '</strong>. ';
        }
        if ($title = $get('title')) {
            if (in_array($type, ['book', 'inbook', 'incollection'])) {
                $html .= '<em>' . e($title) . '</em>. ';
            } else {
                $html .= '"' . e($title) . '." ';
            }
        }

        switch ($type) {
            case 'article':
                if ($journal = $get('journal')) {
                    $html .= ', <em>' . e($journal) . '</em>';
                }
                if ($volume = $get('volume')) {
                    $html .= ', ' . e($volume);
                    if ($number = $get('number')) {
                        $html .= '(' . e($number) . ')';
                    }
                }
                if ($year = $get('year')) {
                    $html .= ' (' . e($year) . ')';
                }
                if ($pages = $get('pages')) {
                    $html .= ', ' . e($pages);
                }
                break;

            case 'book':
            case 'inbook':
                if ($publisher = $get('publisher')) {
                    $html .= e($publisher);
                }
                if ($address = $get('address')) {
                    $html .= ', ' . e($address);
                }
                break;

            case 'incollection':
                if ($booktitle = $get('booktitle')) {
                    $html .= 'In <em>' . e($booktitle) . '</em>';
                }
                if ($editor = $get('editor')) {
                    $html .= ', edited by ' . e($editor);
                }
                if ($publisher = $get('publisher')) {
                    $html .= '. ' . e($publisher);
                }
                break;

            case 'inproceedings':
            case 'conference':
                if ($booktitle = $get('booktitle')) {
                    $html .= 'In <em>' . e($booktitle) . '</em>';
                }
                if ($organization = $get('organization')) {
                    $html .= '. ' . e($organization);
                }
                break;

            case 'phdthesis':
            case 'mastersthesis':
                if ($school = $get('school')) {
                    $html .= e($school);
                }
                break;

            case 'techreport':
                if ($institution = $get('institution')) {
                    $html .= e($institution);
                }
                if ($number = $get('number')) {
                    $html .= ', Technical Report ' . e($number);
                }
                break;

            case 'misc':
            case 'unpublished':
                if ($howpublished = $get('howpublished')) {
                    $html .= e($howpublished);
                }
                break;
        }

        if ($type !== 'article' && ($year = $get('year'))) {
            $html .= ', ' . e($year);
        }

        if ($type !== 'article' && ($pages = $get('pages'))) {
            $html .= ', pp. ' . e($pages);
        }

        if ($doi = $get('doi')) {
            $html .= '. DOI: <a href="https://doi.org/' . e($doi) . '" target="_blank" rel="noopener">' . e($doi) . '</a>';
        }

        if ($note = $get('note')) {
            $html .= '. ' . e($note);
        }

        $html = preg_replace('/\s+/', ' ', $html);
        $html = trim($html);
        if (!empty($html) && !in_array(substr($html, -1), ['.', '!', '?'])) {
            $html .= '.';
        }

        return $html;
    }

    /**
     * A bare-UUID author is an anonymous creator id, not a name
     * (matches the JS bibtexProcessor.js logic).
     */
    private function anonymizeIfNeeded(string $author): string
    {
        if (preg_match('/^[0-9a-fA-F-]{36}$/', $author)) {
            return 'Anon.';
        }

        return $author;
    }
}
