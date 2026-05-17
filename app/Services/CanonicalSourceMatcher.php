<?php

namespace App\Services;

use App\Models\CanonicalSource;
use App\Models\PgLibrary;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Matches a library row to a canonical_source via existing identifiers or external APIs
 * (OpenAlex → Open Library → Semantic Scholar, plus shortened-title retry). Always writes
 * both an identity-confidence score and a metadata-quality score on the link so sloppy
 * library rows are detectable even when identifier matches succeed.
 *
 * See docs/canonical-sources.md for the wave order, scoring semantics, and method values.
 */
class CanonicalSourceMatcher
{
    public const STATUS_ALREADY_LINKED = 'already_linked';
    public const STATUS_LINKED_EXISTING = 'linked_existing';
    public const STATUS_LINKED_NEW = 'linked_new';
    public const STATUS_NO_MATCH = 'no_match';

    public const TITLE_SEARCH_MIN_SCORE = 0.5;

    /**
     * Identifier for the matcher version. Stored on library.canonical_matched_by
     * so future runs (or manual admin overrides) can be distinguished.
     */
    public const MATCHER_IDENTITY = 'canonicalizer_v1';

    public function __construct(
        private OpenAlexService $openAlex,
        private OpenLibraryService $openLibrary,
        private SemanticScholarService $semanticScholar,
    ) {
    }

    /**
     * Find or create a canonical_source for the given library row and link
     * library.canonical_source_id. Idempotent.
     *
     * @return array{
     *   status: string,
     *   canonical_source_id: ?string,
     *   method: ?string,
     *   score: ?float,
     *   reason: string
     * }
     */
    public function match(PgLibrary $library, bool $force = false, bool $dryRun = false): array
    {
        if (!empty($library->canonical_source_id) && !$force) {
            return $this->result(self::STATUS_ALREADY_LINKED, $library->canonical_source_id, null, null, 'library row already linked');
        }

        // 1. Existing canonical via identifier match
        if ($existing = $this->findExistingCanonical($library)) {
            $method = $this->identifierMethod($library, $existing);
            $this->linkLibraryToCanonical($library, $existing, 1.0, $method, $dryRun);
            return $this->result(self::STATUS_LINKED_EXISTING, $existing->id, $method, 1.0, 'matched existing canonical via identifier');
        }

        // 2. Library already carries OpenAlex metadata — promote without API
        if (!empty($library->openalex_id)) {
            $canonical = $this->createCanonicalFromLibraryRow($library, $dryRun);
            $this->linkLibraryToCanonical($library, $canonical, 1.0, 'promote_openalex_metadata', $dryRun);
            return $this->result(self::STATUS_LINKED_NEW, $canonical->id ?? null, 'promote_openalex_metadata', 1.0, 'created canonical from library row\'s existing openalex_id');
        }

        // 3. OpenAlex DOI lookup (instant if DOI present)
        if (!empty($library->doi)) {
            if ($result = $this->tryOpenAlexDoi($library, $dryRun)) return $result;
        }

        // 4. Primary title-search pass: OpenAlex → Open Library → Semantic Scholar
        if (!empty($library->title)) {
            if ($result = $this->tryTitleSearch($library, $library->title, 'full', $dryRun)) return $result;
        }

        // 5. Retry with shortened title (strip subtitle after ":")
        $shortened = $this->shortenTitle($library->title);
        if ($shortened !== null && $shortened !== $library->title) {
            if ($result = $this->tryTitleSearch($library, $shortened, 'short', $dryRun)) return $result;
        }

        return $this->result(self::STATUS_NO_MATCH, null, null, null, 'no canonical or external match found');
    }

    // ──────────────────────────────────────────────────────────────────
    // Wave: external API attempts
    // ──────────────────────────────────────────────────────────────────

    private function tryOpenAlexDoi(PgLibrary $library, bool $dryRun): ?array
    {
        try {
            $normalised = $this->openAlex->fetchByDoi($library->doi);
        } catch (\Throwable $e) {
            $this->logFail('openalex_doi', $library, $e);
            return null;
        }
        if (!$normalised) return null;

        $canonical = $this->upsertCanonicalFromNormalised($normalised, 'openalex_ingest', $dryRun);
        $this->linkLibraryToCanonical($library, $canonical, 1.0, 'openalex_doi', $dryRun);
        return $this->result(self::STATUS_LINKED_NEW, $canonical->id ?? null, 'openalex_doi', 1.0, 'matched via OpenAlex DOI');
    }

    private function tryTitleSearch(PgLibrary $library, string $title, string $variant, bool $dryRun): ?array
    {
        // OpenAlex
        if ($best = $this->bestOpenAlexCandidate($library, $title)) {
            $canonical = $this->upsertCanonicalFromNormalised($best['normalised'], 'openalex_ingest', $dryRun);
            $method = "openalex_title_{$variant}";
            $this->linkLibraryToCanonical($library, $canonical, $best['score'], $method, $dryRun);
            return $this->result(self::STATUS_LINKED_NEW, $canonical->id ?? null, $method, $best['score'], 'matched via OpenAlex title search');
        }

        // Open Library
        if ($best = $this->bestOpenLibraryCandidate($library, $title)) {
            $canonical = $this->upsertCanonicalFromNormalised($best['normalised'], 'open_library_ingest', $dryRun);
            $method = "open_library_{$variant}";
            $this->linkLibraryToCanonical($library, $canonical, $best['score'], $method, $dryRun);
            return $this->result(self::STATUS_LINKED_NEW, $canonical->id ?? null, $method, $best['score'], 'matched via Open Library search');
        }

        // Semantic Scholar
        if ($best = $this->bestSemanticScholarCandidate($library, $title)) {
            $canonical = $this->upsertCanonicalFromNormalised($best['normalised'], 'semantic_scholar_ingest', $dryRun);
            $method = "semantic_scholar_{$variant}";
            $this->linkLibraryToCanonical($library, $canonical, $best['score'], $method, $dryRun);
            return $this->result(self::STATUS_LINKED_NEW, $canonical->id ?? null, $method, $best['score'], 'matched via Semantic Scholar search');
        }

        return null;
    }

    private function bestOpenAlexCandidate(PgLibrary $library, string $title): ?array
    {
        try {
            $candidates = $this->openAlex->fetchFromOpenAlex($title, 5);
        } catch (\Throwable $e) {
            $this->logFail('openalex_title', $library, $e);
            return null;
        }
        return $this->pickBestCandidate($library, $candidates);
    }

    private function bestOpenLibraryCandidate(PgLibrary $library, string $title): ?array
    {
        try {
            $candidates = $this->openLibrary->search($title, $library->author ?: null, 5);
        } catch (\Throwable $e) {
            $this->logFail('open_library_title', $library, $e);
            return null;
        }
        return $this->pickBestCandidate($library, $candidates);
    }

    private function bestSemanticScholarCandidate(PgLibrary $library, string $title): ?array
    {
        try {
            $candidates = $this->semanticScholar->search($title, $library->author ?: null, 5);
        } catch (\Throwable $e) {
            $this->logFail('semantic_scholar_title', $library, $e);
            return null;
        }
        return $this->pickBestCandidate($library, $candidates);
    }

    // ──────────────────────────────────────────────────────────────────
    // Lookup helpers
    // ──────────────────────────────────────────────────────────────────

    private function findExistingCanonical(PgLibrary $library): ?CanonicalSource
    {
        if (!empty($library->openalex_id)) {
            if ($cs = CanonicalSource::where('openalex_id', $library->openalex_id)->first()) return $cs;
        }
        if (!empty($library->doi)) {
            if ($cs = CanonicalSource::where('doi', $library->doi)->first()) return $cs;
        }
        if (!empty($library->open_library_key)) {
            if ($cs = CanonicalSource::where('open_library_key', $library->open_library_key)->first()) return $cs;
        }
        return null;
    }

    private function identifierMethod(PgLibrary $library, CanonicalSource $canonical): string
    {
        if (!empty($library->openalex_id) && $library->openalex_id === $canonical->openalex_id) return 'existing_openalex_id';
        if (!empty($library->doi) && $library->doi === $canonical->doi) return 'existing_doi';
        if (!empty($library->open_library_key) && $library->open_library_key === $canonical->open_library_key) return 'existing_open_library_key';
        return 'existing_unknown';
    }

    private function pickBestCandidate(PgLibrary $library, array $candidates): ?array
    {
        if (empty($candidates)) return null;

        $authors = array_filter(array_map('trim', explode(';', (string) $library->author)));
        $libMeta = [
            'title'     => $library->title,
            'authors'   => array_values($authors),
            'year'      => $library->year,
            'journal'   => $library->journal,
            'publisher' => $library->publisher,
        ];

        $best = null;
        foreach ($candidates as $normalised) {
            $scoreResult = $this->openAlex->metadataScore($libMeta, $normalised);
            $score = (float) ($scoreResult['score'] ?? 0);
            if ($best === null || $score > $best['score']) {
                $best = ['normalised' => $normalised, 'score' => $score];
            }
        }

        return ($best && $best['score'] >= self::TITLE_SEARCH_MIN_SCORE) ? $best : null;
    }

    private function shortenTitle(?string $title): ?string
    {
        if (!$title) return null;
        // Strip a trailing subtitle after the first ":" (common BibTeX pattern).
        $colon = strpos($title, ':');
        if ($colon === false || $colon < 8) return null; // ignore titles that are mostly subtitle
        return trim(substr($title, 0, $colon));
    }

    // ──────────────────────────────────────────────────────────────────
    // canonical_source writes
    // ──────────────────────────────────────────────────────────────────

    private function createCanonicalFromLibraryRow(PgLibrary $library, bool $dryRun): CanonicalSource
    {
        $data = [
            'title'             => $library->title,
            'author'            => $library->author,
            'year'              => $library->year,
            'journal'           => $library->journal,
            'publisher'         => $library->publisher,
            'abstract'          => $library->abstract,
            'type'              => $library->type,
            'language'          => $library->language,
            'doi'               => $library->doi,
            'openalex_id'       => $library->openalex_id,
            'open_library_key'  => $library->open_library_key ?? null,
            'is_oa'             => $library->is_oa,
            'oa_status'         => $library->oa_status,
            'oa_url'            => $library->oa_url ?? null,
            'pdf_url'           => $library->pdf_url ?? null,
            'work_license'      => $library->work_license ?? null,
            'cited_by_count'    => $library->cited_by_count,
            'foundation_source' => 'openalex_ingest',
        ];

        return $dryRun ? new CanonicalSource($data) : CanonicalSource::create($data);
    }

    /**
     * Upsert a canonical_source row from a normalised work array (compatible with
     * OpenAlexService::normaliseWork / OpenLibraryService::normaliseDoc / SemanticScholarService normalised result).
     */
    private function upsertCanonicalFromNormalised(array $n, string $foundationSource, bool $dryRun): CanonicalSource
    {
        // Idempotency: re-use any existing canonical that shares an identifier
        if (!empty($n['openalex_id'])) {
            if ($existing = CanonicalSource::where('openalex_id', $n['openalex_id'])->first()) return $existing;
        }
        if (!empty($n['doi'])) {
            if ($existing = CanonicalSource::where('doi', $n['doi'])->first()) return $existing;
        }
        if (!empty($n['open_library_key'])) {
            if ($existing = CanonicalSource::where('open_library_key', $n['open_library_key'])->first()) return $existing;
        }
        if (!empty($n['semantic_scholar_id'])) {
            if ($existing = CanonicalSource::where('semantic_scholar_id', $n['semantic_scholar_id'])->first()) return $existing;
        }

        $data = [
            'title'               => $n['title'] ?? null,
            'author'              => $n['author'] ?? null,
            'year'                => $n['year'] ?? null,
            'journal'             => $n['journal'] ?? null,
            'publisher'           => $n['publisher'] ?? null,
            'abstract'            => $n['abstract'] ?? null,
            'type'                => $n['type'] ?? null,
            'language'            => $n['language'] ?? null,
            'doi'                 => $n['doi'] ?? null,
            'openalex_id'         => $n['openalex_id'] ?? null,
            'open_library_key'    => $n['open_library_key'] ?? null,
            'is_oa'               => $n['is_oa'] ?? null,
            'oa_status'           => $n['oa_status'] ?? null,
            'oa_url'              => $n['oa_url'] ?? null,
            'pdf_url'             => $n['pdf_url'] ?? null,
            'work_license'        => $n['work_license'] ?? null,
            'cited_by_count'      => $n['cited_by_count'] ?? null,
            'semantic_scholar_id' => $n['semantic_scholar_id'] ?? null,
            'authorships'         => !empty($n['authorships']) ? $n['authorships'] : null,
            'foundation_source'   => $foundationSource,
        ];

        return $dryRun ? new CanonicalSource($data) : CanonicalSource::create($data);
    }

    private function linkLibraryToCanonical(
        PgLibrary $library,
        CanonicalSource $canonical,
        float $score,
        string $method,
        bool $dryRun
    ): void {
        if ($dryRun || !$canonical->exists) return;

        $metadataScore = $this->scoreLibraryAgainstCanonical($library, $canonical);
        $now = now();

        DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $library->book)
            ->update([
                'canonical_source_id'      => $canonical->id,
                'canonical_match_score'    => $score,
                'canonical_metadata_score' => $metadataScore,
                'canonical_match_method'   => $method,
                'canonical_matched_at'     => $now,
                'canonical_matched_by'     => self::MATCHER_IDENTITY,
                'updated_at'               => $now,
            ]);

        $library->canonical_source_id      = $canonical->id;
        $library->canonical_match_score    = $score;
        $library->canonical_metadata_score = $metadataScore;
        $library->canonical_match_method   = $method;
        $library->canonical_matched_at     = $now;
        $library->canonical_matched_by     = self::MATCHER_IDENTITY;
    }

    /**
     * Score the library row's metadata against the canonical's metadata. Used to detect
     * sloppy library rows whose identifier matches but whose title/author/year do not.
     *
     * Returns null only when there's nothing to compare (no title on either side).
     */
    private function scoreLibraryAgainstCanonical(PgLibrary $library, CanonicalSource $canonical): ?float
    {
        if (empty($library->title) || empty($canonical->title)) return null;

        $authors = array_filter(array_map('trim', explode(';', (string) $library->author)));
        $libMeta = [
            'title'     => $library->title,
            'authors'   => array_values($authors),
            'year'      => $library->year,
            'journal'   => $library->journal,
            'publisher' => $library->publisher,
        ];

        $canonicalMeta = [
            'title'     => $canonical->title,
            'author'    => $canonical->author,
            'year'      => $canonical->year,
            'journal'   => $canonical->journal,
            'publisher' => $canonical->publisher,
        ];

        $result = $this->openAlex->metadataScore($libMeta, $canonicalMeta);
        return (float) ($result['score'] ?? 0);
    }

    // ──────────────────────────────────────────────────────────────────
    // Utility
    // ──────────────────────────────────────────────────────────────────

    private function result(string $status, ?string $csId, ?string $method, ?float $score, string $reason): array
    {
        return [
            'status'              => $status,
            'canonical_source_id' => $csId,
            'method'              => $method,
            'score'               => $score,
            'reason'              => $reason,
        ];
    }

    private function logFail(string $where, PgLibrary $library, \Throwable $e): void
    {
        Log::warning("CanonicalSourceMatcher: {$where} failed", [
            'book'  => $library->book,
            'title' => $library->title,
            'err'   => $e->getMessage(),
        ]);
    }
}
