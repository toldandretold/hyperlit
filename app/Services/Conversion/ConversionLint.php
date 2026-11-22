<?php

namespace App\Services\Conversion;

/**
 * Structural lint over a converted book's STORED nodes — "search a journal for problems".
 *
 * The maintainer loop used to be: read a book, notice a glitch, fix the converter, reconvert
 * everything, go back and read more books. That finds one bug per human read. Most conversion
 * defects, though, leave a SHAPE in the stored HTML that can be recognised without knowing the
 * source: a page-break fragment wrapped as a blockquote opens lower-case right after a
 * paragraph that never finished its sentence; a footnote the classifier missed sits in the body
 * as "7 Marx formulated…" while [^7] carries the same text; page chrome repeats verbatim across
 * the journal's articles. Each detector here is one such shape, taken from a real case, and
 * each finding carries the node and an excerpt so a human can confirm it in seconds.
 *
 * Deliberately offline and free: it reads nodes, never the source, never an LLM. It is a
 * TRIAGE ranking — a finding is "look here", not a verdict — and it is most useful as a
 * before/after DIFF around a corpus reconvert (`conversion:lint --save` / `--compare`), where
 * a detector count that moves is evidence about the change, whatever the absolute noise floor.
 *
 * Detector vocabulary (stable keys — snapshots compare by them):
 *   fragment_blockquote  blockquote that opens lower-case after an unfinished sentence (7fa30289)
 *   split_sentence       paragraph that opens lower-case after an unfinished sentence
 *   body_footnote_twin   body paragraph "N text…" whose text IS footnote N (7fa30289 note 7)
 *   orphan_definition    a footnote definition no marker in the body points at
 *   missing_definition   a footnote marker in the body with no definition
 *   raw_marker           unconverted [^N] / $^{N}$ / ^N left in body text
 *   glued_heading_digit  heading ending "Introduction1" with no marker — a lost footnote marker
 *   colon_heading        heading ending in ':' — usually a list lead-in promoted to a heading
 *   long_heading         sub-heading over 160 chars — usually a paragraph promoted to a heading
 *   chrome_leak          a short string repeated across the scope's books (page header/footer)
 */
class ConversionLint
{
    /**
     * Bump when a detector's behaviour changes: stored results (conversion_lint_results) carry
     * the version they were computed with and are recomputed when it moves.
     */
    public const VERSION = 2;

    public const WEIGHTS = [
        'body_footnote_twin'  => 4,
        'fragment_blockquote' => 3,
        'split_sentence'      => 2,
        'orphan_definition'   => 2,
        'missing_definition'  => 2,
        'raw_marker'          => 2,
        'long_heading'        => 2,
        'glued_heading_digit' => 1,
        'colon_heading'       => 1,
        'chrome_leak'         => 1,
    ];

    /** A chrome candidate must recur in at least this many BOOKS of the scope… */
    public const CHROME_MIN_BOOKS = 3;
    /** …or this many times inside ONE book. */
    public const CHROME_MIN_IN_BOOK = 3;

    /** Leading body nodes never read as page furniture: a prolific author's byline repeats across a journal. */
    private const FRONT_MATTER_NODES = 10;

    /**
     * A paragraph that opens with a list enumerator — "b) an abstraction from…", "(ii) …",
     * "c. …". Lower-case by design, and the item before it routinely ends on a comma, which is
     * exactly the split-sentence shape (27e44104's a)/b)/c)/d) list was four false alarms).
     */
    private const ENUMERATOR = '/^\\(?(?:[a-z]|[ivx]{1,5})[).]\\s/u';

    private const TERMINAL = '/[.!?:;)\]"”’\'…]$/u';
    private const PROSE_TAGS = ['p', 'blockquote', 'ul', 'ol'];
    private const SKIPPABLE_TAGS = ['img', 'figure', 'a', 'hr', 'table'];

    /**
     * @param array<int, array{startLine: string, content: string}> $nodes in reading order
     * @param array<string, string>|null $footnotes footnoteId => content (the `footnotes` table —
     *        what the reader actually resolves a marker against; the def nodes in the body do
     *        not all carry an anchor, so they are only used when this is null)
     * @return array{findings: list<array{detector: string, startLine: string, excerpt: string}>,
     *               chrome_candidates: list<string>}
     */
    public function lintBook(array $nodes, ?array $footnotes = null): array
    {
        $body = [];
        $defs = [];           // fn id => definition text
        $defLines = [];       // fn id => startLine of its stored definition node, where one has an anchor
        $inDefs = false;
        foreach ($nodes as $n) {
            $html = (string) ($n['content'] ?? '');
            $tag = $this->tag($html);
            if (preg_match('/^h[1-6]$/', $tag) && preg_match('/>\s*(?:foot|end)?notes\s*</i', $html)) {
                $inDefs = true;
                continue;
            }
            if ($inDefs || preg_match('/^<p[^>]*>\s*<a fn-count-id=/', $html)) {
                if (preg_match('/<a fn-count-id="[^"]*" id="([^"]+)"/', $html, $m)) {
                    $defs[$m[1]] = preg_replace('/^\[\^\d+\]:\s*/', '', $this->text($html));
                    $defLines[$m[1]] = (string) $n['startLine'];
                }
                continue;
            }
            $body[] = ['startLine' => (string) $n['startLine'], 'html' => $html, 'tag' => $tag,
                       'text' => $this->text($html)];
        }

        if ($footnotes !== null) {
            $defs = array_map(fn ($c) => $this->text((string) $c), $footnotes);
        }

        $findings = [];
        $add = function (string $detector, array $node, ?string $excerpt = null) use (&$findings) {
            $findings[] = ['detector' => $detector, 'startLine' => $node['startLine'],
                           'excerpt' => mb_substr($excerpt ?? $node['text'], 0, 220)];
        };

        $inRefs = false;
        $markerIds = [];
        foreach ($body as $i => $node) {
            $tag = $node['tag'];
            $text = $node['text'];

            if (preg_match('/^h[1-6]$/', $tag)) {
                $inRefs = (bool) preg_match('/^\s*(?:\d+\.?\s*)?(?:references|bibliography|works cited|literature)\b/i', $text);
                $bare = preg_replace('/<sup class="footnote-ref".*?<\/sup>/s', '', $node['html']);
                $headText = trim(html_entity_decode(strip_tags($bare), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
                if (preg_match('/\p{Ll}{3,}\d{1,2}$/u', $headText)) {
                    $add('glued_heading_digit', $node, $headText);
                }
                if (str_ends_with($headText, ':')
                        && !preg_match('/^(?:\d+\.?\s*)?(?:references|bibliography|keywords?|abstract|notes)\s*:$/i', $headText)) {
                    $add('colon_heading', $node, $headText);
                }
                // Not the h1: an article's own title is legitimately a sentence ("The Diamond Model of
                // Open Access Publishing: Why Policy Makers, Scholars, …" is 190 characters).
                if ($tag !== 'h1' && mb_strlen($headText) > 160) {
                    $add('long_heading', $node, $headText);
                }
            }

            if (preg_match_all('/<sup class="footnote-ref"[^>]*\bid="([^"]+)"/', $node['html'], $mm)) {
                foreach ($mm[1] as $id) {
                    $markerIds[$id] = $node;
                }
            }

            if (preg_match('/\[\^\d{1,3}\]|\$\^\{?\d{1,3}\}?\$/', $text)) {
                $add('raw_marker', $node);
            }

            if ($inRefs || str_contains($node['html'], 'class="bib-entry"')) {
                continue;     // bibliography entries split differently; not this lint's business
            }

            // A footnote's OCR copy left in the body: "7 Marx formulated…" == def of [^7].
            if ($tag === 'p' && preg_match('/^(\d{1,3})\s+(\S.{30,})/su', $text, $m)) {
                $head = $this->norm($m[2], 40);
                foreach ($defs as $defText) {
                    if (mb_strlen($head) >= 30 && $this->norm($defText, 40) === $head) {
                        $add('body_footnote_twin', $node);
                        break;
                    }
                }
            }

            // Opens lower-case after a sentence that never finished: a page-break split.
            if (in_array($tag, ['p', 'blockquote'], true) && preg_match('/^\p{Ll}/u', $text)) {
                $prev = $this->previousProse($body, $i);
                if ($prev !== null && $this->leavesSentenceOpen($prev['text'])
                        && mb_strlen($text) >= 40 && !preg_match('#^(?:https?:|www\.)#i', $text)
                        && !preg_match(self::ENUMERATOR, $text)) {
                    $add($tag === 'blockquote' ? 'fragment_blockquote' : 'split_sentence', $node,
                        '…' . mb_substr($prev['text'], -70) . ' ‖ ' . mb_substr($text, 0, 120));
                }
            }
        }

        foreach ($defs as $id => $defText) {
            if (!isset($markerIds[$id])) {
                $findings[] = ['detector' => 'orphan_definition', 'startLine' => $defLines[$id] ?? '',
                               'excerpt' => mb_substr($defText, 0, 220)];
            }
        }
        foreach ($markerIds as $id => $node) {
            if (!isset($defs[$id]) && $defs !== []) {
                $add('missing_definition', $node);
            }
        }

        return ['findings' => $findings, 'chrome_candidates' => $this->chromeCandidates($body, $defs)];
    }

    /**
     * Chrome findings across a scope. A page header/footer the OCR glued into text is the same
     * short string in every article of a journal ("© Vienna University of Technology 2003." on
     * every footnote of 7fa30289's issue) — invisible in one book, obvious across ten.
     *
     * @param array<string, list<string>> $candidatesByBook
     * @return array<string, list<string>> book => leaked strings
     */
    public function chromeLeaks(array $candidatesByBook): array
    {
        return $this->chromeLeaksFromCounts(array_map('array_count_values', $candidatesByBook));
    }

    /**
     * The same verdict from pre-counted candidates (string => occurrences per book) — the shape
     * conversion_lint_results stores, so a journal's leaks can be decided without re-linting.
     *
     * @param array<string, array<string, int>> $countsByBook
     * @return array<string, list<string>> book => leaked strings
     */
    public function chromeLeaksFromCounts(array $countsByBook): array
    {
        $books = [];
        foreach ($countsByBook as $book => $counts) {
            foreach ($counts as $c => $n) {
                $books[$c][$book] = $n;
            }
        }
        $out = [];
        foreach ($books as $c => $perBook) {
            $multiBook = count($perBook) >= self::CHROME_MIN_BOOKS;
            foreach ($perBook as $book => $n) {
                if ($multiBook || $n >= self::CHROME_MIN_IN_BOOK) {
                    $out[$book][] = $c;
                }
            }
        }
        return $out;
    }

    /** Weighted score for one book's findings (used for ranking, never as a verdict). */
    public static function score(array $counts): int
    {
        $s = 0;
        foreach ($counts as $d => $n) {
            $s += (self::WEIGHTS[$d] ?? 1) * $n;
        }
        return $s;
    }

    /** A finding's identity across a reconvert: node ids change, the excerpt does not. */
    public static function key(array $finding): string
    {
        return $finding['detector'] . ':' . substr(sha1(
            preg_replace('/\s+/', ' ', mb_strtolower($finding['excerpt']))), 0, 12);
    }

    /**
     * Before/after over two sets of books, each `book => ['counts' => [...], 'keys' => [...]]`.
     * Only books present on BOTH sides are compared — a book that has no content right now (still
     * queued behind a reconvert) or that joined the scope later says nothing about the change.
     *
     * @return array{detectors: array<string, array{0:int,1:int}>, gone: int, new: array<string, list<string>>, compared: int}
     */
    public static function compare(array $before, array $now): array
    {
        $detectors = [];
        $new = [];
        $gone = 0;
        $compared = 0;
        foreach ($now as $book => $b) {
            if (!isset($before[$book])) {
                continue;
            }
            $compared++;
            foreach ($before[$book]['counts'] ?? [] as $d => $n) {
                $detectors[$d][0] = ($detectors[$d][0] ?? 0) + $n;
                $detectors[$d][1] ??= 0;
            }
            foreach ($b['counts'] ?? [] as $d => $n) {
                $detectors[$d][0] ??= 0;
                $detectors[$d][1] = ($detectors[$d][1] ?? 0) + $n;
            }
            $was = $before[$book]['keys'] ?? [];
            $gone += count(array_diff($was, $b['keys'] ?? []));
            $fresh = array_values(array_diff($b['keys'] ?? [], $was));
            if ($fresh) {
                $new[$book] = $fresh;
            }
        }
        ksort($detectors);
        return ['detectors' => $detectors, 'gone' => $gone, 'new' => $new, 'compared' => $compared];
    }

    private function chromeCandidates(array $body, array $defs): array
    {
        $out = [];
        $texts = array_values($defs);
        $inRefs = false;
        foreach ($body as $i => $n) {
            if ($i < self::FRONT_MATTER_NODES) {
                continue;     // byline / affiliation / "Abstract" — the same across one author's articles by design
            }
            if (preg_match('/^h[1-6]$/', $n['tag'])) {
                $inRefs = (bool) preg_match('/^\s*(?:\d+\.?\s*)?(?:references|bibliography|works cited|literature)\b/i', $n['text']);
                continue;     // headings repeat by design ("Conclusion", "About the Authors")
            }
            if ($inRefs || str_contains($n['html'], 'class="bib-entry"')) {
                continue;     // "London: Verso." ends half of every bibliography
            }
            $texts[] = $n['text'];
        }
        foreach ($texts as $t) {
            $t = trim($t);
            if ($t === '') {
                continue;
            }
            // The whole node when it is short (a running head as its own paragraph), else the
            // trailing segment after the last sentence boundary (a footer glued onto a note).
            $cands = [];
            if (mb_strlen($t) <= 100 && !preg_match('/[.!?]\s+\S/u', $t)) {
                $cands[] = $t;
            }
            if (preg_match('/[.!?]\s+([^.!?]{0,80}?(?:[.!?]|\d{4}))\s*$/u', $t, $m)) {
                $cands[] = $m[1];
            }
            foreach ($cands as $c) {
                $c = trim($c);
                if (mb_strlen($c) < 12 || mb_strlen($c) > 100) {
                    continue;
                }
                if (str_starts_with($c, '(') || preg_match('/^(?:ibid|see|cf|op\. cit)\b/i', $c)) {
                    continue;    // citations repeat by nature
                }
                if (!preg_match('/\p{L}{4,}/u', $c)) {
                    continue;
                }
                if (!preg_match('/[\d©:|,.\/]/u', $c)) {
                    continue;    // bare words — a name under "About the Author", not a running head
                }
                $out[] = preg_replace('/\d/', '#', $c);
            }
        }
        return $out;
    }

    /**
     * The paragraph stops mid-sentence: long enough to be prose, no sentence-final mark, and it
     * ends on a WORD — not a URL, an e-mail address, or a "label: value" line (an affiliation
     * block, a variable glossary "vk: value of resource number k" — 7fa30289 / 9a266e34).
     */
    private function leavesSentenceOpen(string $prev): bool
    {
        $prev = rtrim($prev);
        if (mb_strlen($prev) < 40 || preg_match(self::TERMINAL, $prev)) {
            return false;
        }
        $last = preg_split('/\s+/u', $prev);
        $last = end($last);
        if (preg_match('#[@/]|^www\.|\.\w{2,4}$#', $last)) {
            return false;
        }
        if (preg_match('/^\S{1,12}:\s/u', $prev)) {
            return false;
        }
        return (bool) preg_match('/[\p{L},\-–]$/u', $prev);
    }

    private function previousProse(array $body, int $i): ?array
    {
        $skipped = 0;
        for ($j = $i - 1; $j >= 0 && $skipped <= 1; $j--) {
            $tag = $body[$j]['tag'];
            if (in_array($tag, self::PROSE_TAGS, true)) {
                return $body[$j];
            }
            if (!in_array($tag, self::SKIPPABLE_TAGS, true)) {
                return null;     // a heading ends the paragraph — not a page-break split
            }
            $skipped++;
        }
        return null;
    }

    private function tag(string $html): string
    {
        return preg_match('/^\s*<([a-z0-9]+)/i', $html, $m) ? strtolower($m[1]) : '';
    }

    private function text(string $html): string
    {
        $html = preg_replace('/<sup class="footnote-ref".*?<\/sup>/s', '', $html);
        return trim(preg_replace('/\s+/u', ' ',
            html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8')));
    }

    private function norm(string $s, int $len): string
    {
        return mb_substr(trim(preg_replace('/[^a-z0-9]+/', ' ', mb_strtolower($s))), 0, $len);
    }
}
