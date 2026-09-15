<?php

namespace App\Console\Commands;

use App\Models\ConversionFlag;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Audit the ONE citation resolution in the pipeline that GUESSES.
 *
 * Most in-text citations resolve by construction: the author is inside the
 * parentheses, its key matches a bibliography entry, done. But academic prose
 * routinely separates the two — "Similarly, Lévy anticipated … 'quote' argues
 * the philosopher (2002: 33)" — and for those the linker walks BACK through the
 * paragraph and takes the nearest name whose <surname><year> key exists in the
 * bibliography. That is an inference about which name the year belongs to, and
 * the failures it can produce are CONFIDENT WRONG LINKS: a citation pointing at
 * a real entry that is not the work being cited. Five gates keep it honest (see
 * citation_link_rules.py), and each of them was added after watching it produce
 * exactly that.
 *
 * Because it guesses, every such link is stamped in the stored HTML as
 * `data-resolved="antecedent"`. This command reads them back:
 *
 *   - measured from the STORED NODES — offline, free, no re-conversion, and it
 *     works on any book at any time (the per-book assessment.json carries only
 *     an 8-entry sample, and the artifact dir may be long gone);
 *   - scoped to a JOURNAL (via canonical_source.journal_source_id), a shelf, or
 *     one book — a 900-article corpus reconverted in one sweep is the case this
 *     exists for;
 *   - RANKED by how weak the inference is, so a human reads the doubtful end of
 *     the list instead of 900 articles.
 *
 * Sub-books are never audited (`book LIKE '%/%'`): they are parts of a work and
 * their citations were already audited inside the parent.
 *
 * The ranking signals, weakest inference first:
 *   reference_region  the link sits in a paragraph shaped like a bibliography
 *                     entry — a gate escaped; the entry is citing itself.
 *   ambiguous_year    another entry in THIS book shares the year and its surname
 *                     also appears in the paragraph: two candidate targets, and
 *                     the walk-back simply took the nearer one.
 *   cross_sentence    the resolved surname is nowhere in the citation's own
 *                     sentence — it was picked up from an earlier one.
 *   in_sentence       the name and the year are in the same sentence. This is
 *                     the shape the feature exists for and needs the least eyes.
 */
class CitationAuditAntecedentCommand extends Command
{
    protected $signature = 'citations:audit-antecedent
        {--journal= : Journal slug, display-name fragment or journal_sources id (scopes by canonical_source)}
        {--shelf= : Shelf id — audit the books on this shelf}
        {--book= : Audit one book}
        {--limit=0 : Stop after N books (0 = all)}
        {--sample=60 : Max links to print/write per rank (0 = all)}
        {--out= : Write the full review list to this file (.md)}
        {--stats : Print the per-book distribution only}
        {--flag : Raise a conversion_flag for each book carrying a weak-inference link}
        {--unflag : UNDO — delete the flags a previous --flag run raised, and stop}
        {--force : Flag even when the weak-link rate looks implausible}';

    protected $description = 'Audit citation links resolved by the antecedent-author walk-back (the one guessing resolution)';

    /** Above this share of audited BOOKS carrying a weak link, refuse to flag: suspect the measure. */
    private const SANE_WEAK_RATE = 0.5;

    /**
     * …but a RATE only means something across a corpus. On `--book=x` the rate is 1.0 by
     * construction, and on a handful of books it is noise — the guard exists to stop a
     * mis-calibrated ranking writing hundreds of flags, not to block a targeted run.
     */
    private const MIN_BOOKS_FOR_RATE_GUARD = 20;

    /** Marks the flags this command raises so --unflag removes exactly those. */
    private const ISSUE_TYPE = 'antecedent_citation_link';

    private const RANKS = ['reference_region', 'ambiguous_year', 'cross_sentence', 'in_sentence'];

    public function handle(): int
    {
        if ($this->option('unflag')) {
            return $this->unflag();
        }

        $db = DB::connection('pgsql_admin');
        $books = $this->scope($db);
        if ($books->isEmpty()) {
            $this->info('No books in scope.');
            return self::SUCCESS;
        }

        $this->line("Auditing {$books->count()} book(s) for antecedent-resolved citation links…");
        $this->newLine();

        $findings = [];          // rank => list of finding rows
        $perBook = [];           // book => counts
        foreach ($books as $row) {
            $links = $this->auditBook($db, $row->book);
            if (!$links) {
                continue;
            }
            $counts = array_fill_keys(self::RANKS, 0);
            foreach ($links as $link) {
                $counts[$link['rank']]++;
                $findings[$link['rank']][] = ['book' => $row->book, 'title' => (string) $row->title] + $link;
            }
            $perBook[$row->book] = ['title' => (string) $row->title, 'counts' => $counts,
                                    'total' => count($links)];
        }

        $total = array_sum(array_map(fn ($b) => $b['total'], $perBook));
        if ($total === 0) {
            $this->info('No antecedent-resolved links found in scope.');
            $this->line('Books converted before this provenance existed carry no marker — reconvert to audit them.');
            return self::SUCCESS;
        }

        $this->printSummary($books->count(), $perBook, $findings, $total);
        $this->printLedger($db, $books->pluck('book'));

        if ($this->option('stats')) {
            return self::SUCCESS;
        }

        $this->printFindings($findings);

        if ($path = $this->option('out')) {
            file_put_contents($path, $this->reviewDocument($books->count(), $perBook, $findings, $total));
            $this->newLine();
            $this->info("Full review list → {$path}");
        }

        return $this->option('flag')
            ? $this->flag($perBook, $books->count())
            : $this->hint();
    }

    /** Books to audit: journal, shelf, single book, or every book with nodes. */
    private function scope($db)
    {
        $query = $db->table('library')
            ->where('has_nodes', true)
            ->where('book', 'not like', '%/%');

        if ($book = $this->option('book')) {
            $query->where('book', $book);
        }
        if ($shelf = $this->option('shelf')) {
            $query->whereIn('book', function ($q) use ($shelf) {
                $q->select('book')->from('shelf_items')->where('shelf_id', $shelf);
            });
        }
        if ($journal = $this->option('journal')) {
            $sourceId = $this->resolveJournal($db, $journal);
            if ($sourceId === null) {
                $this->error("No journal_sources row matches '{$journal}'.");
                return collect();
            }
            $query->whereIn('canonical_source_id', function ($q) use ($sourceId) {
                $q->select('id')->from('canonical_source')->where('journal_source_id', $sourceId);
            });
        }
        if (($limit = (int) $this->option('limit')) > 0) {
            $query->limit($limit);
        }

        return $query->orderBy('book')->get(['book', 'title']);
    }

    private function resolveJournal($db, string $needle): ?string
    {
        // `id` is a uuid column: comparing it to a slug fragment is a Postgres CAST ERROR, not a
        // miss ("invalid input syntax for type uuid"), so only try it when the needle IS a uuid.
        $isUuid = (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $needle);
        $row = $db->table('journal_sources')
            ->when($isUuid, fn ($q) => $q->where('id', $needle))
            ->when(!$isUuid, fn ($q) => $q->where('slug', $needle)
                ->orWhere('display_name', 'ilike', '%' . $needle . '%'))
            ->first(['id', 'display_name']);
        if ($row) {
            $this->line("Journal: {$row->display_name}");
        }
        return $row->id ?? null;
    }

    /**
     * Every antecedent-resolved link in one book, with the evidence a human needs
     * to judge it: the sentence it sits in, the entry it resolved to, and a rank.
     */
    private function auditBook($db, string $book): array
    {
        $nodes = $db->table('nodes')->where('book', $book)
            ->orderBy('chunk_id')->orderBy('startLine')
            ->get(['content', 'plainText']);

        // The book's own bibliography: anchor id => [surname, year]. Used for the
        // ambiguous-year test (is there a rival entry the walk-back passed over?).
        $entries = [];
        foreach ($nodes as $n) {
            if (preg_match_all('/<a class="bib-entry" id="([^"]+)"/', (string) $n->content, $m)) {
                foreach ($m[1] as $id) {
                    if (preg_match('/^(.*?)(\d{4})[a-z]?$/', $id, $parts)) {
                        $entries[$id] = ['surname' => $parts[1], 'year' => $parts[2]];
                    }
                }
            }
        }

        $out = [];
        foreach ($nodes as $n) {
            $html = (string) $n->content;
            if (!str_contains($html, 'data-resolved="antecedent"')
                    && !str_contains($html, 'data-resolved="ambiguous"')) {
                continue;
            }
            $plain = trim(preg_replace('/\s+/', ' ', strip_tags($html)));
            $isEntryish = $this->looksLikeReferenceEntry($plain);

            // Both provenance markers: single-candidate walk-backs ("antecedent") and the
            // multi-candidate ones ("ambiguous", which additionally carry data-candidates and
            // live in the citation_resolutions ledger for /maintainer/citations).
            preg_match_all(
                '/<a class="in-text-citation"(?: data-candidates="[^"]*")? '
                . 'data-resolved="(?:antecedent|ambiguous)" href="#([^"]+)">([^<]*)<\/a>/',
                $html, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE
            );
            foreach ($matches as $m) {
                $target = $m[1][0];
                $year = $m[2][0];
                $before = trim(preg_replace('/\s+/', ' ', strip_tags(substr($html, 0, (int) $m[0][1]))));
                $sentence = $this->sentenceAround($before, $year);
                $entry = $entries[$target] ?? ['surname' => preg_replace('/\d{4}[a-z]?$/', '', $target),
                                               'year' => $year];
                $inSentence = $entry['surname'] !== ''
                    && str_contains($this->fold($sentence), $this->fold($entry['surname']));

                $rivals = [];
                foreach ($entries as $id => $e) {
                    if ($id !== $target && $e['year'] === $entry['year'] && $e['surname'] !== ''
                            && str_contains($this->fold($before), $this->fold($e['surname']))) {
                        $rivals[] = $id;
                    }
                }

                $rank = $isEntryish ? 'reference_region'
                    : ($rivals ? 'ambiguous_year'
                    : ($inSentence ? 'in_sentence' : 'cross_sentence'));

                $out[] = [
                    'target'   => $target,
                    'year'     => $year,
                    'rank'     => $rank,
                    'rivals'   => $rivals,
                    'sentence' => $sentence,
                ];
            }
        }

        return $out;
    }

    /** The citation's own sentence (the tail of the preceding text), plus the year. */
    private function sentenceAround(string $before, string $year): string
    {
        $tail = mb_substr($before, -400);
        $parts = preg_split('/(?<=[.!?])\s+(?=[A-Z“"\'(])/u', $tail);
        $sentence = trim((string) end($parts));
        if (mb_strlen($sentence) < 80 && count($parts) > 1) {
            $sentence = trim($parts[count($parts) - 2] . ' ' . $sentence);
        }
        return $sentence . " ⟦{$year}⟧";
    }

    /** The same shape the linker's own gate uses: author-first opener + an early year. */
    private function looksLikeReferenceEntry(string $text): bool
    {
        return (bool) preg_match('/^\s*[A-ZÀ-Þ][A-Za-zÀ-ÿ\'’-]+,\s*(?:[A-Z]\.|[A-Z][a-zà-ÿ]+)/u', $text)
            && (bool) preg_match('/\(?(?:1[5-9]\d\d|20\d\d)[a-z]?\)?/', mb_substr($text, 0, 160));
    }

    /**
     * Case- and diacritic-folded comparison key. Str::ascii, NOT iconv//TRANSLIT: the latter is
     * platform-dependent and renders "Häyhtio" as "Ha?yhtio" on macOS, which made a surname that IS
     * in the sentence rank as cross_sentence.
     */
    private function fold(string $s): string
    {
        return mb_strtolower(\Illuminate\Support\Str::ascii($s));
    }

    private function printSummary(int $audited, array $perBook, array $findings, int $total): void
    {
        $byRank = array_map(fn ($r) => count($findings[$r] ?? []), array_combine(self::RANKS, self::RANKS));
        $this->info(sprintf(
            '%d antecedent-resolved link(s) across %d of %d audited book(s).',
            $total, count($perBook), $audited,
        ));
        foreach (self::RANKS as $rank) {
            $n = $byRank[$rank];
            $line = sprintf('  %-16s %5d  (%s)', $rank, $n, $this->rankBlurb($rank));
            $n && in_array($rank, ['reference_region', 'ambiguous_year'], true)
                ? $this->warn($line) : $this->line($line);
        }

        $worst = collect($perBook)
            ->map(fn ($b, $book) => ['book' => $book, 'title' => $b['title'],
                                     'weak' => $b['counts']['reference_region'] + $b['counts']['ambiguous_year']
                                               + $b['counts']['cross_sentence'],
                                     'total' => $b['total']])
            ->filter(fn ($b) => $b['weak'] > 0)
            ->sortByDesc('weak')->take(10);
        if ($worst->isNotEmpty()) {
            $this->newLine();
            $this->line('Books with the most weak inferences:');
            foreach ($worst as $b) {
                $this->line(sprintf('  %s  %d weak / %d  %s', $b['book'], $b['weak'], $b['total'],
                    mb_strimwidth($b['title'], 0, 64, '…')));
            }
        }
    }

    /** The maintainer-answer ledger's state for the audited scope. */
    private function printLedger($db, $books): void
    {
        $counts = $db->table('citation_resolutions')
            ->whereIn('book', $books)
            ->selectRaw("status, count(*) as n")->groupBy('status')->pluck('n', 'status');
        if ($counts->isEmpty()) {
            return;
        }
        $this->newLine();
        $this->line(sprintf(
            'Ambiguity ledger for this scope: %d pending question(s), %d answered — review at /maintainer/citations',
            (int) ($counts['pending'] ?? 0), (int) ($counts['resolved'] ?? 0),
        ));
    }

    private function rankBlurb(string $rank): string
    {
        return [
            'reference_region' => 'in a reference-entry paragraph — a gate escaped, read these first',
            'ambiguous_year'   => 'a rival entry shares the year and is named nearby',
            'cross_sentence'   => 'the resolved author is not in the citation’s own sentence',
            'in_sentence'      => 'author and year in one sentence — the intended shape',
        ][$rank];
    }

    private function printFindings(array $findings): void
    {
        $cap = (int) $this->option('sample');
        foreach (self::RANKS as $rank) {
            $rows = $findings[$rank] ?? [];
            if (!$rows || $rank === 'in_sentence') {
                continue;                       // the strong shape stays in the --out file only
            }
            $this->newLine();
            $this->line("── {$rank} ({$this->rankBlurb($rank)})");
            foreach ($cap > 0 ? array_slice($rows, 0, $cap) : $rows as $r) {
                $this->line(sprintf('  %s → #%s', substr($r['book'], 0, 8), $r['target']));
                $this->line('     ' . mb_strimwidth($r['sentence'], 0, 150, '…'));
            }
            if ($cap > 0 && count($rows) > $cap) {
                $this->line(sprintf('  … %d more (raise --sample or use --out)', count($rows) - $cap));
            }
        }
    }

    private function reviewDocument(int $audited, array $perBook, array $findings, int $total): string
    {
        $lines = ['# Antecedent-resolved citation links — review list', ''];
        $lines[] = sprintf('%d link(s) across %d of %d audited book(s), %s.', $total, count($perBook),
            $audited, now()->toDayDateTimeString());
        $lines[] = '';
        $lines[] = 'Each link below was resolved by the walk-back: the citation named no author, so the';
        $lines[] = 'nearest preceding name in the paragraph was used. Weakest inference first.';
        foreach (self::RANKS as $rank) {
            $rows = $findings[$rank] ?? [];
            if (!$rows) {
                continue;
            }
            $lines[] = '';
            $lines[] = "## {$rank} — {$this->rankBlurb($rank)} (" . count($rows) . ')';
            foreach ($rows as $r) {
                $lines[] = '';
                $lines[] = sprintf('- **%s** → `#%s`%s', $r['book'], $r['target'],
                    $r['rivals'] ? ' — rivals: `' . implode('`, `', $r['rivals']) . '`' : '');
                $lines[] = '  - ' . $r['title'];
                $lines[] = '  - ' . $r['sentence'];
            }
        }
        return implode("\n", $lines) . "\n";
    }

    private function hint(): int
    {
        $this->newLine();
        $this->line('Nothing was written. Options: --out=review.md for the full list,');
        $this->line('--flag to queue the weak ones at /maintainer/conversion, --stats for counts only.');
        return self::SUCCESS;
    }

    private function flag(array $perBook, int $audited): int
    {
        $weakBooks = array_filter($perBook, fn ($b) => $b['counts']['reference_region']
            + $b['counts']['ambiguous_year'] + $b['counts']['cross_sentence'] > 0);
        $rate = count($weakBooks) / max(1, $audited);

        if ($audited >= self::MIN_BOOKS_FOR_RATE_GUARD && $rate > self::SANE_WEAK_RATE
                && !$this->option('force')) {
            $this->newLine();
            $this->error(sprintf('REFUSING to flag: %.1f%% of audited books carry a weak link (ceiling %.0f%%).',
                $rate * 100, self::SANE_WEAK_RATE * 100));
            $this->line('At that rate the RANKING is wrong, not the corpus. Read --stats and a few');
            $this->line('--out entries first; add --force if you really mean it.');
            return self::FAILURE;
        }

        foreach ($weakBooks as $book => $b) {
            ConversionFlag::raise(
                $book,
                ConversionFlag::SOURCE_AUTO_SWEEP,
                sprintf('%d citation link(s) resolved by the antecedent-author walk-back need a look '
                    . '(%d in a reference paragraph, %d with a rival entry, %d cross-sentence)',
                    $b['total'], $b['counts']['reference_region'], $b['counts']['ambiguous_year'],
                    $b['counts']['cross_sentence']),
                [
                    'issueTypes' => [self::ISSUE_TYPE],
                    'counts'     => $b['counts'],
                    'case_kind'  => BookExport::KIND_CONVERSION,
                    'audited_at' => now()->toIso8601String(),
                ],
            );
        }

        $this->newLine();
        $this->line(count($weakBooks) . ' flagged → triage at /maintainer/conversion');
        $this->line('Undo with: php artisan citations:audit-antecedent --unflag');
        return self::SUCCESS;
    }

    private function unflag(): int
    {
        $deleted = DB::table('conversion_flags')
            ->where('source', ConversionFlag::SOURCE_AUTO_SWEEP)
            ->whereRaw("jsonb_exists(details->'issueTypes', ?)", [self::ISSUE_TYPE])
            ->delete();
        $this->info("Deleted {$deleted} antecedent-link audit flag(s).");
        $this->line('User reports and other sweeps were not touched.');
        return self::SUCCESS;
    }
}
