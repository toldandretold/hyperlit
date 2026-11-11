<?php

namespace App\Services\Licensing;

use App\Services\BookCache;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Licensing\Sources\ArxivSource;
use App\Services\Licensing\Sources\CrossrefSource;
use App\Services\Licensing\Sources\DataCiteSource;
use App\Services\Licensing\Sources\EuropePmcSource;
use App\Services\Licensing\Sources\FetchTraceSource;
use App\Services\Licensing\Sources\InternetArchiveSource;
use App\Services\Licensing\Sources\LicenseSource;
use App\Services\Licensing\Sources\LivePageSource;
use App\Services\Licensing\Sources\OaLocationsSource;
use App\Services\Licensing\Sources\OpenAlexSource;
use App\Services\Licensing\Sources\PageMetaSource;
use App\Services\Licensing\Sources\SemanticScholarSource;
use App\Services\SourceHarvest\OaLicenseMapper;
use App\Support\Licenses;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Goes and FINDS the licence of a third-party work whose stored licence is a guess — `Unknown`
 * (no evidence at mint time), `Open-Unspecified`, a CC family with no stated version, or a
 * code inferred from OA status alone. Driven by `php artisan library:discover-licenses`.
 *
 * Sources are walked cheapest-first (local artefacts, then upstream APIs), stopping at the
 * first CONCLUSIVE answer: a recognised licence that states its version, or a definitive
 * non-CC one (public domain, publisher terms, arXiv's licence). Everything any source said is
 * written to `license_evidence` — silence included — so a decision can be re-made offline and
 * "why is this still Unknown?" has an answer.
 *
 * Decision rules (decide()):
 *  - the recognised licence from the most AUTHORITATIVE source wins (AUTHORITY: hosted copy >
 *    publisher page / registry deposit > arXiv > aggregators > Internet Archive), ladder order
 *    breaking ties;
 *  - a version-less CC family is upgraded by a LATER source stating a version of the SAME
 *    family (OpenAlex "cc-by" + Crossref ".../by/4.0/" → CC-BY-4.0) — never by a different one;
 *  - public domain / CC0 asserted ONLY by aggregators is not accepted;
 *  - `Open-Unspecified` is upgraded by a later specific open licence (never by "all rights
 *    reserved", which would contradict it);
 *  - with nothing recognised, an unrecognised terms URL becomes `custom` linking to it;
 *    otherwise there is no decision and the row keeps its licence.
 *
 * It never touches a row a person chose a licence for (`license_source = 'user'`) or a user's
 * own book — only works Hyperlit did not author (system-minted rows and URL imports).
 */
class LicenseDiscovery
{
    public const SOURCE_USER = 'user';

    /** Stamped by remap when the code was inferred from OA status alone. */
    public const SOURCE_STATUS = 'status';

    /** Stamped by remap when the code came from the row's own work_license / DOAJ evidence. */
    public const SOURCE_REMAP = 'remap';

    public const SYSTEM_CREATORS = [AutoVersionResolver::CREATOR, 'OpenAlex', 'Semantic_scholar', 'Openlibrary', 'WebFetch'];

    public const SCOPES = ['unknown', 'open-unspecified', 'versionless', 'status-inferred', 'all'];

    public const COOLDOWN_DAYS = 30;

    /** Consecutive "couldn't ask" failures before a source is switched off for the run. */
    public const BREAKER = 5;

    /** @var list<LicenseSource> */
    private array $sources;

    /** @var array<string, int> */
    private array $infraStreak = [];

    /** @var array<string, true> */
    public array $disabled = [];

    /** @param list<LicenseSource>|null $sources ladder order, cheapest first */
    public function __construct(?array $sources = null)
    {
        $this->sources = $sources ?? self::defaultSources();
    }

    /** @return list<LicenseSource> */
    public static function defaultSources(bool $fetchPages = false): array
    {
        return array_values(array_filter([
            new FetchTraceSource(),
            new OaLocationsSource(),
            new PageMetaSource(),
            new CrossrefSource(),
            new DataCiteSource(),
            new OpenAlexSource(),
            new EuropePmcSource(),
            new SemanticScholarSource(),
            new ArxivSource(),
            new InternetArchiveSource(),
            $fetchPages ? new LivePageSource() : null,
        ]));
    }

    /** @return list<string> */
    public function sourceNames(): array
    {
        return array_map(fn (LicenseSource $s) => $s->name(), $this->sources);
    }

    /**
     * Ask the sources about one row (live).
     *
     * @return array{decision: ?array{license: string, custom_license_text: ?string, license_url: ?string, source: string}, evidence: list<array{source: string, raw: ?string, code: ?string, version_stated: bool, note: ?string}>, reason: string}
     */
    public function discover(object $row): array
    {
        $evidence = [];
        $applied = 0;

        foreach ($this->sources as $source) {
            $name = $source->name();
            if (isset($this->disabled[$name]) || ! $source->applies($row)) {
                continue;
            }
            $applied++;

            try {
                $finding = $source->lookup($row);
            } catch (\Throwable $e) {
                Log::warning('licence source threw', ['source' => $name, 'book' => $row->book, 'error' => $e->getMessage()]);
                $finding = \App\Services\Licensing\Sources\LicenseFinding::failed($e->getMessage());
            }

            if ($finding->infra) {
                $this->infraStreak[$name] = ($this->infraStreak[$name] ?? 0) + 1;
                if ($this->infraStreak[$name] >= self::BREAKER) {
                    $this->disabled[$name] = true;
                    Log::warning('licence source disabled for this run after repeated failures', ['source' => $name, 'last' => $finding->note]);
                }

                continue;
            }
            $this->infraStreak[$name] = 0;

            $code = $finding->raw !== null ? (OaLicenseMapper::parse($finding->raw)['license'] ?? null) : null;
            $evidence[] = [
                'source' => $name,
                'raw' => $finding->raw,
                'code' => $code,
                'version_stated' => $code !== null && Licenses::statesVersion($code),
                'note' => $finding->note,
            ];

            // Stop asking only when an AUTHORITATIVE source is conclusive. An aggregator's
            // answer (OpenAlex / Unpaywall slugs) is kept but the ladder goes on, because the
            // publisher's own deposit outranks it in decide().
            if ($code !== null && self::isConclusive($code) && self::authority($name) <= self::authority('arxiv')) {
                break;
            }
        }

        $decision = self::decide($evidence);

        return [
            'decision' => $decision,
            'evidence' => $evidence,
            'reason' => $decision ? 'found' : ($applied === 0 ? 'no identifier' : 'sources silent'),
        ];
    }

    /**
     * How much a source's word counts — NOT the order we ask in (that is cost). Lower wins:
     * the copy we host, then the publisher's own page and registry deposit, then arXiv's
     * record, then aggregators (whose slugs are useful but demonstrably sometimes wrong — an
     * Unpaywall "public-domain" on a 2010s Springer book), then Internet Archive's per-scan
     * assessment.
     */
    public const AUTHORITY = [
        'fetch_trace' => 0,
        'page_meta' => 1,
        'live_page' => 1,
        'crossref' => 2,
        'datacite' => 2,
        'arxiv' => 3,
        'oa_locations' => 4,
        'openalex' => 4,
        'europepmc' => 4,
        'semantic_scholar' => 4,
        'internet_archive' => 5,
    ];

    public static function authority(string $source): int
    {
        return self::AUTHORITY[$source] ?? 9;
    }

    /** A code good enough to stop asking: versioned, or a definitive non-CC licence. */
    public static function isConclusive(string $code): bool
    {
        return Licenses::statesVersion($code) && ! in_array($code, ['Open-Unspecified', Licenses::UNKNOWN, Licenses::CUSTOM], true);
    }

    /**
     * @param  list<array{source: string, raw: ?string, code: ?string}>  $evidence  ladder order
     * @return array{license: string, custom_license_text: ?string, license_url: ?string, source: string}|null
     */
    public static function decide(array $evidence): ?array
    {
        $recognised = array_values(array_filter($evidence, fn ($e) => ($e['code'] ?? null) !== null
            && ! in_array($e['code'], [Licenses::UNKNOWN, Licenses::CUSTOM], true)));
        // "Anyone may do anything" is the strongest claim we can print, and the aggregators'
        // public-domain slugs are the least reliable thing they carry (they share data, so
        // three of them agreeing is one witness). Public domain / CC0 needs a witness that
        // isn't an aggregator: the hosted copy, the publisher, arXiv, or Internet Archive.
        $recognised = array_values(array_filter($recognised, fn ($e) => ! (in_array($e['code'], ['PDM', 'CC0'], true)
            && self::authority($e['source']) === self::AUTHORITY['openalex'])));
        // Most authoritative first; ladder order breaks ties (usort is stable).
        usort($recognised, fn ($a, $b) => self::authority($a['source']) <=> self::authority($b['source']));

        if ($recognised) {
            $win = $recognised[0];
            if (! Licenses::statesVersion($win['code'])) {
                foreach (array_slice($recognised, 1) as $e) {
                    if (Licenses::ccFamily($e['code']) === $win['code']) {
                        $win = $e;
                        break;
                    }
                }
            } elseif ($win['code'] === 'Open-Unspecified') {
                foreach (array_slice($recognised, 1) as $e) {
                    if (! in_array($e['code'], ['Open-Unspecified', 'All-Rights-Reserved', Licenses::ARXIV_NONEXCLUSIVE], true)) {
                        $win = $e;
                        break;
                    }
                }
            }
            $cols = OaLicenseMapper::parse($win['raw']);

            return $cols + ['source' => $win['source']];
        }

        foreach ($evidence as $e) {
            if (is_string($e['raw'] ?? null) && preg_match('#^https?://\S+$#i', trim($e['raw']))) {
                return OaLicenseMapper::toLibraryLicense($e['raw']) + ['source' => $e['source']];
            }
        }

        return null;
    }

    /**
     * Re-make the decision from stored evidence (no network) — what `--apply` does for rows a
     * dry run already asked about.
     *
     * @return array{decision: ?array, evidence: list<array>, reason: string}|null  null = no fresh evidence
     */
    public function fromStoredEvidence(string $book, int $cooldownDays = self::COOLDOWN_DAYS): ?array
    {
        $rows = DB::connection('pgsql_admin')->table('license_evidence')
            ->where('book', $book)
            ->where('checked_at', '>', now()->subDays($cooldownDays))
            ->get(['source', 'raw', 'mapped_code', 'version_stated', 'note']);
        if ($rows->isEmpty()) {
            return null;
        }

        $order = array_flip(array_map(fn (LicenseSource $s) => $s->name(), self::defaultSources(true)));
        $evidence = $rows->sortBy(fn ($r) => $order[$r->source] ?? 999)->values()->map(fn ($r) => [
            'source' => $r->source,
            'raw' => $r->raw,
            // Re-parse: the mapper may have learned since the evidence was stored.
            'code' => $r->raw !== null ? (OaLicenseMapper::parse($r->raw)['license'] ?? null) : null,
            'version_stated' => (bool) $r->version_stated,
            'note' => $r->note,
        ])->all();

        $decision = self::decide($evidence);

        return ['decision' => $decision, 'evidence' => $evidence, 'reason' => $decision ? 'found' : 'sources silent'];
    }

    /** Persist what each source said (silence included). */
    public static function recordEvidence(string $book, array $evidence): void
    {
        if ($evidence === []) {
            return;
        }
        $now = now();
        DB::connection('pgsql_admin')->table('license_evidence')->upsert(
            array_map(fn ($e) => [
                'book' => $book,
                'source' => $e['source'],
                'raw' => $e['raw'] !== null ? mb_substr($e['raw'], 0, 2000) : null,
                'mapped_code' => $e['code'],
                'version_stated' => (bool) $e['version_stated'],
                'note' => isset($e['note']) ? mb_substr((string) $e['note'], 0, 500) : null,
                'checked_at' => $now,
            ], $evidence),
            ['book', 'source'],
            ['raw', 'mapped_code', 'version_stated', 'note', 'checked_at'],
        );
    }

    /**
     * Would the decision change the stored licence? (A decision equal to what's stored is a
     * confirmation, not a change.)
     */
    public static function changes(object $row, ?array $decision): bool
    {
        if ($decision === null || ($row->license_source ?? null) === self::SOURCE_USER) {
            return false;
        }

        return $decision['license'] !== $row->license
            || ($decision['license_url'] ?? null) !== ($row->license_url ?? null)
            || ($decision['custom_license_text'] ?? null) !== ($row->custom_license_text ?? null);
    }

    /**
     * Write a decision. Bumps `library.timestamp` + drops the BookCache for a CHANGED row so open
     * readers and the prerender pick it up; an unchanged row only gets its checked stamp.
     */
    public static function apply(object $row, ?array $decision): bool
    {
        $db = DB::connection('pgsql_admin');
        $now = now();

        if (! self::changes($row, $decision)) {
            $db->table('library')->where('book', $row->book)->update(['license_checked_at' => $now]);

            return false;
        }

        $db->table('library')
            ->where('book', $row->book)
            ->where(fn ($q) => $q->whereNull('license_source')->orWhere('license_source', '!=', self::SOURCE_USER))
            ->update([
                'license' => $decision['license'],
                'custom_license_text' => $decision['custom_license_text'] ?? null,
                'license_url' => $decision['license_url'] ?? null,
                'license_source' => $decision['source'],
                'license_checked_at' => $now,
                'timestamp' => (int) round(microtime(true) * 1000),
                'updated_at' => $now,
            ]);

        try {
            app(BookCache::class)->invalidate($row->book);
        } catch (\Throwable) {
            // best effort — the prerender rebuilds on its own once the timestamp moved
        }

        return true;
    }

    /**
     * Restrict a `library` query (aliased) to WORKS Hyperlit did not author: system-minted rows
     * and URL imports — and not their sub-books (`{book}/Fn…` footnote/annotation books,
     * `{book}/HL_…` AI-review notes) or synthetic shelf renders (`shelf_…`), which are parts
     * of a page, not works with licences of their own. Shared with library:remap-licenses.
     */
    public static function thirdPartyWorks($q, string $alias = 'l'): void
    {
        $q->where(function ($w) use ($alias) {
            $w->whereIn("{$alias}.creator", self::SYSTEM_CREATORS)
                ->orWhereRaw("{$alias}.raw_json->>'imported_via' = 'url'");
        })
            ->where("{$alias}.book", 'not like', '%/%')
            ->whereRaw("{$alias}.book not like 'shelf\\_%'");
    }

    /**
     * Books in scope, hosted texts first. Plucked up front (not a lazy offset walk) because
     * applying a decision moves a row OUT of the scope, which would make offset pagination
     * skip rows.
     *
     * @param  list<string>  $books
     * @return list<string>
     */
    public static function candidateBooks(string $scope, array $books = [], bool $apply = false, int $limit = 0, int $cooldownDays = self::COOLDOWN_DAYS): array
    {
        $q = DB::connection('pgsql_admin')->table('library as l')
            ->where(fn ($w) => self::thirdPartyWorks($w))
            ->where(fn ($w) => $w->whereNull('l.license_source')->orWhere('l.license_source', '!=', self::SOURCE_USER))
            ->where(fn ($w) => self::scopePredicate($w, $scope))
            ->when($apply && ! $books, fn ($w) => $w->where(fn ($c) => $c->whereNull('l.license_checked_at')
                ->orWhere('l.license_checked_at', '<', now()->subDays($cooldownDays))))
            ->when($books, fn ($w) => $w->whereIn('l.book', $books))
            ->orderByDesc('l.has_nodes')
            ->orderBy('l.book')
            ->when($limit > 0, fn ($w) => $w->limit($limit));

        return $q->pluck('l.book')->all();
    }

    private static function scopePredicate($w, string $scope): void
    {
        $families = array_values(array_filter(Licenses::codes(), fn ($c) => ! Licenses::statesVersion($c)));
        $arms = [
            'unknown' => fn ($q) => $q->where('l.license', Licenses::UNKNOWN),
            'open-unspecified' => fn ($q) => $q->where('l.license', 'Open-Unspecified'),
            'versionless' => fn ($q) => $q->whereIn('l.license', $families),
            'status-inferred' => fn ($q) => $q->whereIn('l.license', ['All-Rights-Reserved', 'Open-Unspecified'])
                ->where('l.license_source', self::SOURCE_STATUS),
        ];
        if ($scope === 'all') {
            foreach ($arms as $arm) {
                $w->orWhere(fn ($q) => $arm($q));
            }

            return;
        }
        ($arms[$scope] ?? throw new \InvalidArgumentException("unknown scope {$scope}"))($w);
    }

    /** The row projection the sources read. @param list<string> $books @return array<string, object> */
    public static function loadRows(array $books): array
    {
        return DB::connection('pgsql_admin')->table('library as l')
            ->leftJoin('canonical_source as c', 'c.id', '=', 'l.canonical_source_id')
            ->whereIn('l.book', $books)
            ->get([
                'l.book', 'l.license', 'l.custom_license_text', 'l.license_url', 'l.license_source',
                'l.doi', 'l.openalex_id', 'l.open_library_key', 'l.url', 'l.oa_url', 'l.pdf_url', 'l.has_nodes',
                'c.doi as c_doi', 'c.openalex_id as c_openalex_id', 'c.open_library_key as c_open_library_key',
                'c.oa_locations',
            ])
            ->keyBy('book')
            ->all();
    }
}
