<?php

namespace App\Services\Hypercites;

use App\Models\JournalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

/**
 * What the candidate detector runs OVER: a collection of citing books. Two
 * kinds exist — a journal (its enumerated canonicals, resolved to their best
 * readable versions) and a public shelf (its items ARE books, canonical or
 * not). Everything downstream is identical, which is the point: the shelf
 * case reuses the whole pipeline instead of forking it.
 *
 * `isInternal` is the scope's own membership test — "the cited work is also
 * in this collection" — surfaced on candidates as the `is_internal` flag.
 */
class DetectionScope
{
    /** @var array<string,true> */
    private array $memberCanonicalIds = [];

    /** @var array<string,true> */
    private array $memberBooks = [];

    private function __construct(
        public readonly string $type,          // journal | shelf
        public readonly ?string $journalSourceId,
        public readonly ?string $shelfId,
        public readonly string $label,
    ) {}

    public static function forJournal(JournalSource $journal): self
    {
        return new self('journal', $journal->id, null, (string) $journal->display_name);
    }

    public static function forShelf(object $shelf): self
    {
        return new self('shelf', null, (string) $shelf->id, (string) $shelf->name);
    }

    /** The scope columns every candidate/run row carries (exactly one set). */
    public function rowColumns(): array
    {
        return [
            'journal_source_id' => $this->journalSourceId,
            'shelf_id'          => $this->shelfId,
        ];
    }

    /**
     * The citing books to walk: [{book, canonical_id|null, title}]. Also
     * primes the membership sets isInternal() checks against.
     *
     * @return array<int, array{book:string, canonical_id:?string, title:?string}>
     */
    public function citingEntries(BestVersionService $versions): array
    {
        $db = DB::connection('pgsql_admin');
        $entries = [];

        if ($this->type === 'journal') {
            $canonicals = \App\Models\CanonicalSource::on('pgsql_admin')
                ->where('journal_source_id', $this->journalSourceId)
                ->orderByRaw('cited_by_count DESC NULLS LAST')
                ->get();
            foreach ($canonicals as $canonical) {
                $this->memberCanonicalIds[$canonical->id] = true;
                $resolved = $versions->bestPublicContentVersion($canonical);
                if ($resolved) {
                    $this->memberBooks[$resolved['book']] = true;
                    $entries[] = [
                        'book'         => $resolved['book'],
                        'canonical_id' => $canonical->id,
                        'title'        => $canonical->title,
                    ];
                }
            }

            return $entries;
        }

        $rows = $db->table('shelf_items as si')
            ->join('library as l', 'l.book', '=', 'si.book')
            ->where('si.shelf_id', $this->shelfId)
            ->where('l.has_nodes', true)
            ->where('l.visibility', '!=', 'deleted')
            ->orderBy('si.added_at')
            ->get(['l.book', 'l.canonical_source_id', 'l.title']);

        foreach ($rows as $r) {
            $this->memberBooks[$r->book] = true;
            if ($r->canonical_source_id) {
                $this->memberCanonicalIds[$r->canonical_source_id] = true;
            }
            $entries[] = [
                'book'         => $r->book,
                'canonical_id' => $r->canonical_source_id,
                'title'        => $r->title,
            ];
        }

        return $entries;
    }

    /** Call only after citingEntries() has primed the membership sets. */
    public function isInternal(?string $citedCanonicalId, string $citedBook): bool
    {
        return isset($this->memberBooks[$citedBook])
            || ($citedCanonicalId !== null && isset($this->memberCanonicalIds[$citedCanonicalId]));
    }
}
