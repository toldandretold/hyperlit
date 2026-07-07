<?php

namespace App\Services\AiBrain;

use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Formats the client-supplied {@see \App\Http\Controllers\AiBrainController} selection
 * context into a compact plain-text "READING CONTEXT" preamble for the LLM, so the
 * model reads the passage as an informed reader would: knowing WHERE it sits (highlight
 * / footnote / AI response nesting + authorship + the root book's citation) and WHAT
 * links it contains (citations + hypercites).
 *
 * This is the PRIVACY AUTHORITY for hypercite target text: the client's gate is a
 * best-effort token-saver, but here we RE-CHECK the target book's visibility before
 * ever emitting its quoted passage (mirrors SearchService's visibility clause + the
 * E2EE encrypted-book guard). Kept as its own service so it is unit-testable without
 * the streaming controller (tests/Feature/AiBrain/ReadingContextPrivacyTest.php).
 */
class ReadingContextFormatter
{
    /**
     * @param  array|null  $selectionContext  the validated `selectionContext` payload
     * @param  array       $rootMeta          ['title'=>, 'author'=>, 'year'=>] of the root book
     * @param  object      $user              the authenticated user (for owner privacy checks)
     */
    public function build(?array $selectionContext, array $rootMeta, $user): string
    {
        $lines = [];

        $nesting = $this->nestingClause($selectionContext, $rootMeta);
        if ($nesting !== '') {
            $lines[] = $nesting;
            $authorship = $this->authorshipLine($selectionContext);
            if ($authorship !== '') $lines[] = $authorship;
        }

        foreach ($this->citationLines($selectionContext['citations'] ?? []) as $line) {
            $lines[] = $line;
        }

        foreach ($this->hyperciteLines($selectionContext['hypercites'] ?? [], $user) as $line) {
            $lines[] = $line;
        }

        if (empty($lines)) return '';

        return "READING CONTEXT (framing — NOT the user's question; use it to read closely, never quote it back verbatim):\n- "
            . implode("\n- ", $lines);
    }

    /**
     * Render the nesting chain innermost→outward, tailed with the root book, e.g.
     * "The selected text sits inside a highlight annotation by @sam, inside a footnote,
     *  in book "Capital" by Marx (1867)."
     * Returns '' when there is no nesting chain (the SELECTED PASSAGE label already
     * names the book in that case).
     */
    private function nestingClause(?array $selectionContext, array $rootMeta): string
    {
        $chain = $selectionContext['chain'] ?? [];
        if (empty($chain)) return '';

        // chain arrives root→inner; render innermost first ("inside X, inside Y").
        $inner = array_reverse($chain);
        $parts = array_map(fn($level) => $this->describeLevel($level), $inner);

        $prefix = !empty($selectionContext['chainTruncated'])
            ? '(nesting continues above — showing the innermost ' . count($chain) . ' levels) '
            : '';

        $clause = 'The selected text sits inside ' . $prefix . implode(', inside ', $parts);

        $book = $this->bookCitation($rootMeta);
        if ($book !== '') $clause .= ', in book ' . $book;

        return $clause . '.';
    }

    private function describeLevel(array $level): string
    {
        $type = $level['type'] ?? 'highlight';
        $creator = $this->clean($level['creator'] ?? '', 100);

        if ($type === 'footnote') return 'a footnote';
        if ($type === 'ai-response' || !empty($level['isAi'])) return 'an AI Archivist response';

        return $creator !== ''
            ? 'a highlight annotation by @' . $creator
            : 'an anonymous highlight annotation';
    }

    private function authorshipLine(?array $selectionContext): string
    {
        $immediate = $selectionContext['immediateContainer'] ?? null;
        if (!is_array($immediate)) {
            $chain = $selectionContext['chain'] ?? [];
            $immediate = !empty($chain) ? end($chain) : null; // chain is root→inner, so last = innermost
        }
        if (!is_array($immediate)) return '';

        $type = $immediate['type'] ?? 'highlight';
        if ($type === 'footnote') {
            return 'The passage is embedded within a footnote.';
        }
        if ($type === 'ai-response' || !empty($immediate['isAi'])) {
            return 'The passage is inside a response written by the AI Archivist itself.';
        }
        $creator = $this->clean($immediate['creator'] ?? '', 100);
        return $creator !== ''
            ? 'The passage is inside an annotation left by the reader @' . $creator . '.'
            : 'The passage is inside an anonymous reader annotation.';
    }

    /** @return string[] */
    private function citationLines(array $citations): array
    {
        if (empty($citations)) return [];
        $out = [];
        foreach ($citations as $c) {
            if (!is_array($c)) continue;
            $content = $this->clean($c['content'] ?? '', 400);
            if ($content === '') {
                $title = $this->clean($c['title'] ?? '', 300);
                $author = $this->clean($c['author'] ?? '', 200);
                $year = $this->clean($c['year'] ?? '', 20);
                $authorYear = trim($author . ($year !== '' ? " ({$year})" : ''));
                $content = implode(' — ', array_filter([$title, $authorYear]));
                if ($content === '') $content = 'details unavailable';
            }
            $out[] = 'Citation in the selection: ' . $content;
        }
        return $out;
    }

    /** @return string[] */
    private function hyperciteLines(array $hypercites, $user): array
    {
        if (empty($hypercites)) return [];
        $out = [];
        foreach ($hypercites as $h) {
            if (!is_array($h)) continue;
            $targetBook = (string) ($h['targetBook'] ?? '');
            $text = $this->clean($h['hypercitedText'] ?? '', 300);

            // PRIVACY RE-CHECK — never emit target text unless the target book is
            // public or owned by this user, and never for an encrypted book.
            if ($text !== '' && $targetBook !== '' && $this->mayRevealTarget($targetBook, $user)) {
                $title = $this->clean($h['targetBookTitle'] ?? '', 300);
                $author = $this->clean($h['targetBookAuthor'] ?? '', 200);
                $source = $title !== '' ? '"' . $title . '"' : 'another book';
                if ($author !== '') $source .= ' by ' . $author;
                $out[] = 'The selection links (hypercites) to the passage "' . $text . '" in ' . $source
                    . ' — consider whether that passage supports or challenges the point being made.';
            } else {
                $out[] = 'The selection links (hypercites) to a passage in a private or unavailable book — '
                    . 'its text is withheld; do not speculate about its contents.';
            }
        }
        return $out;
    }

    private function mayRevealTarget(string $targetBook, $user): bool
    {
        if (EncryptedBookGuard::isEncrypted($targetBook)) return false;

        $row = DB::table('library')->where('book', $targetBook)
            ->select('visibility', 'creator')->first();
        if (!$row) return false;

        $username = is_object($user) ? ($user->name ?? null) : null;
        return $row->visibility === 'public' || ($username !== null && $row->creator === $username);
    }

    private function bookCitation(array $rootMeta): string
    {
        $title = $this->clean($rootMeta['title'] ?? '', 300);
        if ($title === '' || $title === 'Unknown') $title = '';
        $author = $this->clean($rootMeta['author'] ?? '', 200);
        $year = $this->clean($rootMeta['year'] ?? '', 20);

        if ($title === '' && $author === '') return '';

        $out = $title !== '' ? '"' . $title . '"' : 'an untitled work';
        if ($author !== '') $out .= ' by ' . $author;
        if ($year !== '') $out .= ' (' . $year . ')';
        return $out;
    }

    /** Collapse whitespace + cap length; the preamble is plain LLM text, not HTML. */
    private function clean($value, int $max): string
    {
        $s = trim(preg_replace('/\s+/', ' ', (string) $value));
        return Str::limit($s, $max, '…');
    }
}
