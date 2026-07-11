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
     * The [check source] confirm flow is a HUMAN-confirmation UI (the user picks from a shortlist),
     * NOT the autonomous match() path — so it uses its own, looser thresholds. We surface anything
     * above the garbage floor (so weak-but-plausible titles still show, the user filters by eye) and
     * cap the shortlist. These deliberately diverge from TITLE_SEARCH_MIN_SCORE, which stays strict
     * for the autonomous match()/library:canonicalize path. See docs/canonical-sources.md.
     */
    public const PREVIEW_MIN_SCORE = 0.15;   // matches metadataScore's title_floor: drops only junk
    public const PREVIEW_MAX_CANDIDATES = 3;  // top-N shown as "is it one of these?"

    /** Sentinel method written to library.canonical_match_method on no_match,
     *  so subsequent --missing-only runs can skip recently-tried rows. */
    public const NO_MATCH_METHOD = 'no_match_v1';

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

        // 3. OpenAlex DOI lookup (instant if DOI present — incl. a DOI that only lives in url/bibtex)
        $resolvedDoi = $this->resolveDoi($library);
        if (!empty($resolvedDoi)) {
            if ($result = $this->tryOpenAlexDoi($library, $resolvedDoi, $dryRun)) return $result;
        }

        // Title-search waves (4 & 5) need BOTH a usable title and an author to be
        // worth the API spend. Without an author, the matcher's metadataScore can't
        // disambiguate which of several candidates is actually the right work, and
        // we end up either burning calls for no reason or risking false positives.
        // Identifier waves (1–3) are unaffected — DOI / openalex_id / open_library_key
        // are authoritative on their own.
        if ($this->hasUsableTitleAndAuthor($library)) {
            // 4. Primary title-search pass: OpenAlex → Open Library → Semantic Scholar
            if ($result = $this->tryTitleSearch($library, $library->title, 'full', $dryRun)) return $result;

            // 5. Retry with shortened title (strip subtitle after ":")
            $shortened = $this->shortenTitle($library->title);
            if ($shortened !== null && $shortened !== $library->title) {
                if ($result = $this->tryTitleSearch($library, $shortened, 'short', $dryRun)) return $result;
            }
        }

        $this->stampNoMatch($library, $dryRun);
        return $this->result(self::STATUS_NO_MATCH, null, null, null, 'no canonical or external match found');
    }

    /**
     * Read-only sibling of match(): runs the same wave order but RETURNS the candidate citation
     * data (the normalised work) WITHOUT writing anything, so the frontend can show the user
     * "is this the source?" before committing. match(dryRun:true) is no good for this — it discards
     * the candidate and returns no id. Used by the [check source] flow (SourceVerificationController).
     *
     * @return array{
     *   status: string,
     *   method: ?string,
     *   score: ?float,
     *   candidate: ?array,        // normalised-work shape (OpenAlexService::normaliseWork)
     *   alternates: array,        // other ranked title-search hits (for a future "not this one?")
     *   alreadyLinked: bool,
     *   current: ?array           // the currently-linked canonical, if any
     * }
     */
    /**
     * Read-only candidate preview for the [check source] confirm flow. Waves 0–3 (identifier/DOI)
     * return a single confident candidate at score 1.0; waves 4/5 (title + ISBN) return a ranked
     * SHORTLIST for the user to pick from. When $forVerify is true the shortlist is NOT truncated
     * to PREVIEW_MAX_CANDIDATES, so verify() can re-resolve any candidate the user was shown even
     * if the ranking shifted between the lookup and the confirm click.
     */
    public function preview(PgLibrary $library, bool $forVerify = false): array
    {
        // Already linked — report the current canonical (a re-check can still be forced by the
        // caller passing a fresh row, but by default we surface what it's linked to).
        if (!empty($library->canonical_source_id)) {
            $current = CanonicalSource::find($library->canonical_source_id);
            return $this->previewResult(
                self::STATUS_ALREADY_LINKED,
                $library->canonical_match_method,
                $library->canonical_match_score !== null ? (float) $library->canonical_match_score : null,
                null,
                [],
                true,
                $current ? $this->canonicalToCandidate($current) : null,
            );
        }

        // 1. Existing canonical via identifier
        if ($existing = $this->findExistingCanonical($library)) {
            return $this->previewResult(
                self::STATUS_LINKED_EXISTING,
                $this->identifierMethod($library, $existing),
                1.0,
                $this->canonicalToCandidate($existing),
            );
        }

        // 2. Library already carries OpenAlex metadata — promote without an API call
        if (!empty($library->openalex_id)) {
            return $this->previewResult(
                self::STATUS_LINKED_NEW,
                'promote_openalex_metadata',
                1.0,
                $this->libraryRowAsCandidate($library),
            );
        }

        // 3. OpenAlex DOI lookup (incl. a DOI that only lives in url/bibtex)
        $resolvedDoi = $this->resolveDoi($library);
        if (!empty($resolvedDoi)) {
            try {
                $normalised = $this->openAlex->fetchByDoi($resolvedDoi);
                if ($normalised) {
                    return $this->previewResult(self::STATUS_LINKED_NEW, 'openalex_doi', 1.0, $normalised);
                }
            } catch (\Throwable $e) {
                $this->logFail('openalex_doi', $library, $e);
            }
        }

        // 4 & 5. Broad shortlist search (title + ISBN, full then shortened). Confirm-flow only:
        // author is NOT required (the human disambiguates), we only gate on a usable title.
        if ($this->hasUsableTitle($library)) {
            $limit = $forVerify ? PHP_INT_MAX : self::PREVIEW_MAX_CANDIDATES;
            $isbnCandidates = $this->previewIsbnCandidates($library);

            if ($found = $this->previewBroadSearch($library, $library->title, 'full', $isbnCandidates, $limit)) return $found;

            $shortened = $this->shortenTitle($library->title);
            if ($shortened !== null && $shortened !== $library->title) {
                if ($found = $this->previewBroadSearch($library, $shortened, 'short', $isbnCandidates, $limit)) return $found;
            }
        }

        return $this->previewResult(self::STATUS_NO_MATCH, null, null, null);
    }

    /**
     * Read-only candidate preview seeded from arbitrary citation METADATA (a bibliography reference's
     * llm_metadata) rather than a saved library row — the reference-level [check source] flow. Builds
     * an in-memory (unsaved) PgLibrary from the metadata and runs the exact same preview() waves, so
     * all the search/scoring/dedupe logic is reused verbatim. Never writes.
     *
     * @param array $meta {title, authors?: string[], author?: string, year?, journal?, publisher?, type?, doi?, url?}
     */
    public function previewFromMetadata(array $meta, bool $forVerify = false): array
    {
        $author = $meta['author'] ?? null;
        if (!$author && !empty($meta['authors']) && is_array($meta['authors'])) {
            $author = implode('; ', array_filter($meta['authors']));
        }

        // Unsaved row — preview() only READS these fields; nothing is persisted. canonical_source_id
        // is deliberately left null so we always search for candidates (a re-check).
        $library = new PgLibrary([
            'title'     => $meta['title'] ?? null,
            'author'    => $author,
            'year'      => $meta['year'] ?? null,
            'journal'   => $meta['journal'] ?? null,
            'publisher' => $meta['publisher'] ?? null,
            'type'      => $meta['type'] ?? null,
            'doi'       => $meta['doi'] ?? null,
            'url'       => $meta['url'] ?? null,
        ]);

        return $this->preview($library, $forVerify);
    }

    /**
     * Apply a user-confirmed match: upsert the canonical from the (server-resolved) normalised work,
     * link the library row to it, AND overwrite the library row's IDENTITY citation fields from the
     * canonical (the user confirmed this IS the source). Version-specific fields the canonical does
     * not model (volume/issue/pages/booktitle/chapter/editor/url/note) are left untouched. Stamps the
     * verified state: method='user_verified' + human_reviewed_at. Library writes use pgsql_admin
     * (RLS bypass) — the CALLER must have already authorised the edit.
     */
    public function verifyAndLink(PgLibrary $library, array $normalised, string $matchedBy): CanonicalSource
    {
        $foundation = $this->foundationFromSource($normalised['source'] ?? null);
        $canonical = $this->upsertCanonicalFromNormalised($normalised, $foundation, false);

        $now = now();
        $metadataScore = $this->scoreLibraryAgainstCanonical($library, $canonical);

        DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $library->book)
            ->update([
                // link + verified state
                'canonical_source_id'      => $canonical->id,
                'canonical_match_score'    => 1.0,
                'canonical_metadata_score' => $metadataScore,
                'canonical_match_method'   => 'user_verified',
                'canonical_matched_at'     => $now,
                'canonical_matched_by'     => $matchedBy,
                'human_reviewed_at'        => $now,
                // overwrite identity fields from the canonical
                'title'               => $canonical->title,
                'author'              => $canonical->author,
                'year'                => $canonical->year,
                'journal'             => $canonical->journal,
                'publisher'           => $canonical->publisher,
                'doi'                 => $canonical->doi,
                'type'                => $canonical->type,
                'abstract'            => $canonical->abstract,
                'language'            => $canonical->language,
                'openalex_id'         => $canonical->openalex_id,
                'open_library_key'    => $canonical->open_library_key,
                // (library has no semantic_scholar_id column — it lives only on canonical_source)
                'is_oa'               => $canonical->is_oa,
                'oa_status'           => $canonical->oa_status,
                'oa_url'              => $canonical->oa_url,
                'pdf_url'             => $canonical->pdf_url,
                'work_license'        => $canonical->work_license,
                'cited_by_count'      => $canonical->cited_by_count,
                // refresh the display bibtex so the source panel's citation reflects the verified work
                'bibtex'              => $normalised['bibtex'] ?? $library->bibtex,
                'updated_at'          => $now,
            ]);

        return $canonical;
    }

    /**
     * Record that the user looked the source up and rejected the suggestion (or none was found),
     * so the UI can show "checked — no match" and not re-prompt. Mirrors stampNoMatch but credits
     * the human and sets human_reviewed_at.
     */
    public function stampUserRejected(PgLibrary $library, string $matchedBy): void
    {
        $now = now();
        DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $library->book)
            ->update([
                'canonical_match_method' => 'user_rejected',
                'canonical_matched_at'   => $now,
                'canonical_matched_by'   => $matchedBy,
                'human_reviewed_at'      => $now,
                'updated_at'             => $now,
            ]);
    }

    /**
     * Title-search guard. Both title and author must be present and non-junk for the
     * matcher to have enough signal to disambiguate candidates. Junk titles ("Untitled",
     * very short strings, all-numeric) silently waste API calls and can produce dodgy
     * matches when a candidate happens to score above threshold by coincidence.
     */
    /**
     * Confirm-flow title guard: the same junk/length checks as hasUsableTitleAndAuthor but WITHOUT
     * the author requirement — the [check source] UI shows a shortlist and the human disambiguates,
     * so a title alone is enough signal. Gate is "is there a real title at all?".
     */
    private function hasUsableTitle(PgLibrary $library): bool
    {
        $title = trim((string) ($library->title ?? ''));

        if ($title === '') return false;
        if (strlen($title) < 5) return false;
        if (preg_match('/^(untitled|new (book|document)|test|sample|draft)$/i', $title)) return false;
        if (preg_match('/^[\d\s]+$/', $title)) return false;
        if (preg_match('/^(.)\1+$/', $title)) return false;

        return true;
    }

    private function hasUsableTitleAndAuthor(PgLibrary $library): bool
    {
        $title  = trim((string) ($library->title  ?? ''));
        $author = trim((string) ($library->author ?? ''));

        if ($title === '' || $author === '') return false;
        if (strlen($title) < 5) return false;

        // The placeholder title we ship with the "new book" form, plus common junk
        // patterns. Anchored at the start so legitimate titles containing the word
        // (e.g. an art-history reference to "Untitled (1948)") still pass — provided
        // they have more after it.
        if (preg_match('/^(untitled|new (book|document)|test|sample|draft)$/i', $title)) return false;
        // All-numeric or repeating-single-char titles are degenerate.
        if (preg_match('/^[\d\s]+$/', $title)) return false;
        if (preg_match('/^(.)\1+$/', $title)) return false;

        return true;
    }

    /**
     * Record that the matcher tried this row and failed all waves. Lets future
     * `--missing-only` runs skip rows tried recently, instead of re-burning
     * three external API calls per row every run.
     */
    private function stampNoMatch(PgLibrary $library, bool $dryRun): void
    {
        if ($dryRun) return;

        $now = now();
        DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $library->book)
            ->update([
                'canonical_match_method' => self::NO_MATCH_METHOD,
                'canonical_matched_at'   => $now,
                'canonical_matched_by'   => self::MATCHER_IDENTITY,
                'updated_at'             => $now,
            ]);

        $library->canonical_match_method = self::NO_MATCH_METHOD;
        $library->canonical_matched_at   = $now;
        $library->canonical_matched_by   = self::MATCHER_IDENTITY;
    }

    /**
     * Promote an already-normalised work (OpenAlexService::normaliseWork shape) into
     * a canonical_source row and link the given library row to it.
     *
     * Used by import flows that *already have* OpenAlex metadata in hand (e.g. the
     * URL-import path resolves metadata during inspect), so we don't re-fetch what
     * we already fetched. Returns the upserted CanonicalSource.
     *
     * @param array $normalised  Same shape as OpenAlexService::normaliseWork()
     */
    public function linkFromNormalisedWork(
        PgLibrary $library,
        array $normalised,
        string $foundationSource = 'openalex_ingest',
        string $method = 'openalex_doi'
    ): CanonicalSource {
        $canonical = $this->upsertCanonicalFromNormalised($normalised, $foundationSource, false);
        $this->linkLibraryToCanonical($library, $canonical, 1.0, $method, false);
        return $canonical;
    }

    /**
     * Find-or-create a WEB canonical, identity-keyed on the URL, and link the
     * library row to it. This is the version-grouping canonical for a
     * non-academic source whose page content has been VERIFIED against the
     * citation (caller's responsibility — never call this for an unverified or
     * title-only match). It carries NO academic signals: type='web',
     * foundation_source='web_verified', no DOI/openalex_id — the honest claim
     * is "a URL that had this content", not "a legitimate authored work".
     * Multiple library rows for the same URL group under one such canonical.
     */
    public function linkWebSourceToCanonical(
        PgLibrary $library,
        string $url,
        ?string $title = null,
        ?string $author = null,
        ?int $year = null
    ): CanonicalSource {
        $canonical = CanonicalSource::where('source_url', $url)->first();
        if (!$canonical) {
            $canonical = CanonicalSource::create([
                'source_url'        => $url,
                'title'             => $title,
                'author'            => $author,
                'year'              => $year,
                'type'              => 'web',           // NOT 'article' — honest marking
                'foundation_source' => 'web_verified',
            ]);
        }
        // match_score 1.0 = URL+content identity confirmed; method names the route.
        $this->linkLibraryToCanonical($library, $canonical, 1.0, 'web_url_verified', false);
        return $canonical;
    }

    // ──────────────────────────────────────────────────────────────────
    // Wave: external API attempts
    // ──────────────────────────────────────────────────────────────────

    private function tryOpenAlexDoi(PgLibrary $library, string $doi, bool $dryRun): ?array
    {
        try {
            $normalised = $this->openAlex->fetchByDoi($doi);
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
        $doi = $this->resolveDoi($library);
        if (!empty($doi)) {
            if ($cs = CanonicalSource::where('doi', $doi)->first()) return $cs;
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

    /**
     * The DOI to match on: the `doi` column if set, otherwise one extracted from the `url` or
     * `bibtex` (uploads frequently put the DOI in the URL — e.g. https://doi.org/10.x/… — and
     * never normalise it into the `doi` column, which silently skipped the instant DOI wave).
     */
    private function resolveDoi(PgLibrary $library): ?string
    {
        if (!empty($library->doi)) return $library->doi;
        foreach ([(string) ($library->url ?? ''), (string) ($library->bibtex ?? '')] as $text) {
            if ($text === '') continue;
            $doi = $this->openAlex->extractDoi($text);
            if ($doi) return $doi;
        }
        return null;
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
     * Public entry-point used by the citation search path. Wraps the private
     * upsert so the CitationSearchService can write external API results
     * (OpenAlex/Open Library) into canonical_source without going through the
     * library-row-first canonicalize pipeline. Idempotent — repeat calls with the
     * same identifier return the existing canonical.
     */
    public function ingestExternal(array $normalised, string $foundationSource): CanonicalSource
    {
        return $this->upsertCanonicalFromNormalised($normalised, $foundationSource, false);
    }

    /**
     * Upsert a canonical_source row from a normalised work array (compatible with
     * OpenAlexService::normaliseWork / OpenLibraryService::normaliseDoc / SemanticScholarService normalised result).
     */
    private function upsertCanonicalFromNormalised(array $n, string $foundationSource, bool $dryRun): CanonicalSource
    {
        // Idempotency: re-use any existing canonical that shares an identifier. Backfill missing OA
        // fields from the fresh candidate (a work first canonicalised without OA data — e.g. a
        // DOI-only pipeline match — gains its readable oa_url/pdf_url when re-resolved by title).
        if (!empty($n['openalex_id'])) {
            if ($existing = CanonicalSource::where('openalex_id', $n['openalex_id'])->first()) return $this->backfillOaFields($existing, $n, $dryRun);
        }
        if (!empty($n['doi'])) {
            if ($existing = CanonicalSource::where('doi', $n['doi'])->first()) return $this->backfillOaFields($existing, $n, $dryRun);
        }
        if (!empty($n['open_library_key'])) {
            if ($existing = CanonicalSource::where('open_library_key', $n['open_library_key'])->first()) return $this->backfillOaFields($existing, $n, $dryRun);
        }
        if (!empty($n['semantic_scholar_id'])) {
            if ($existing = CanonicalSource::where('semantic_scholar_id', $n['semantic_scholar_id'])->first()) return $this->backfillOaFields($existing, $n, $dryRun);
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

    /**
     * Fill in OA/full-text fields on an existing canonical that lacks them, from a fresh normalised
     * candidate. Only writes columns that are currently null/empty — never overwrites curated data.
     */
    private function backfillOaFields(CanonicalSource $existing, array $n, bool $dryRun): CanonicalSource
    {
        if ($dryRun) return $existing;

        $fill = [];
        foreach (['oa_url', 'pdf_url', 'oa_status', 'work_license'] as $f) {
            if (($existing->$f === null || $existing->$f === '') && !empty($n[$f])) {
                $fill[$f] = $n[$f];
            }
        }
        if ($existing->is_oa === null && array_key_exists('is_oa', $n) && $n['is_oa'] !== null) {
            $fill['is_oa'] = $n['is_oa'];
        }

        if ($fill) {
            $existing->forceFill($fill)->save();
        }
        return $existing;
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

    // ──────────────────────────────────────────────────────────────────
    // Preview helpers (read-only; no DB writes)
    // ──────────────────────────────────────────────────────────────────

    private function previewResult(
        string $status,
        ?string $method,
        ?float $score,
        ?array $candidate,
        array $alternates = [],
        bool $alreadyLinked = false,
        ?array $current = null,
    ): array {
        return [
            'status'        => $status,
            'method'        => $method,
            'score'         => $score,
            'candidate'     => $candidate,
            'alternates'    => $alternates,
            'alreadyLinked' => $alreadyLinked,
            'current'       => $current,
        ];
    }

    /**
     * Broad shortlist search for the confirm flow. Unlike the autonomous tryTitleSearch (first
     * provider to clear 0.5 wins), this AGGREGATES all providers + any ISBN hits into one pool,
     * ranks + dedupes them, keeps everything above the loose PREVIEW_MIN_SCORE floor, and returns
     * the top $limit as candidate + alternates for the user to pick from. No writes.
     */
    private function previewBroadSearch(PgLibrary $library, string $title, string $variant, array $isbnCandidates, int $limit): ?array
    {
        $pool = $isbnCandidates;

        $providers = [
            ['openalex',         fn() => $this->openAlex->fetchFromOpenAlex($title, 5)],
            ['open_library',     fn() => $this->openLibrary->search($title, $library->author ?: null, 5)],
            ['semantic_scholar', fn() => $this->semanticScholar->search($title, $library->author ?: null, 5)],
        ];
        foreach ($providers as [$name, $fetch]) {
            try {
                $pool = array_merge($pool, $fetch());
            } catch (\Throwable $e) {
                $this->logFail("{$name}_title", $library, $e);
            }
        }

        if (empty($pool)) return null;

        $ranked = $this->dedupeRanked($this->rankCandidates($library, $pool));
        $ranked = array_values(array_filter($ranked, fn($r) => $r['score'] >= self::PREVIEW_MIN_SCORE));
        if (empty($ranked)) return null;

        $top = array_slice($ranked, 0, $limit);
        $src = (string) ($top[0]['normalised']['source'] ?? 'external');

        // Annotate each candidate with its own score so the confirm UI can show per-row confidence.
        // match_score is a transient display field — the canonical write-path ignores unknown keys.
        $annotate = fn($r) => $r['normalised'] + ['match_score' => round((float) $r['score'], 4)];

        return $this->previewResult(
            self::STATUS_LINKED_NEW,
            "{$src}_{$variant}",
            $top[0]['score'],
            $annotate($top[0]),
            array_map($annotate, array_slice($top, 1)),
        );
    }

    /**
     * ISBN candidates for the pool: extract an ISBN from bibtex/url (there is no isbn column) and
     * look it up on Open Library. A correct-ISBN edition scores high via the normal scorer, so it
     * needs no special-casing — it just enters the ranked pool. Returns [] when there's no ISBN.
     */
    private function previewIsbnCandidates(PgLibrary $library): array
    {
        $isbn = $this->resolveIsbn($library);
        if ($isbn === null) return [];
        try {
            return $this->openLibrary->searchByIsbn($isbn, 5);
        } catch (\Throwable $e) {
            $this->logFail('open_library_isbn', $library, $e);
            return [];
        }
    }

    /** The ISBN to look up: extracted from `bibtex` or `url` (mirrors resolveDoi; no isbn column). */
    private function resolveIsbn(PgLibrary $library): ?string
    {
        foreach ([(string) ($library->bibtex ?? ''), (string) ($library->url ?? '')] as $text) {
            if ($text === '') continue;
            $isbn = $this->openAlex->extractIsbn($text);
            if ($isbn) return $isbn;
        }
        return null;
    }

    /**
     * Collapse candidates that are the same work (same identifier, else same title+year). Input is
     * already sorted best-first, so the first occurrence of each key is the highest-scoring — keep it.
     */
    private function dedupeRanked(array $ranked): array
    {
        $seen = [];
        $out = [];
        foreach ($ranked as $r) {
            $n = $r['normalised'];
            $key = $n['doi'] ?? $n['openalex_id'] ?? $n['open_library_key'] ?? $n['semantic_scholar_id'] ?? null;
            if (!$key) {
                $title = strtolower(trim((string) ($n['title'] ?? '')));
                if ($title === '') { $out[] = $r; continue; }  // no signal to dedupe on — keep it
                $key = $title . '|' . (string) ($n['year'] ?? '');
            }
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $out[] = $r;
        }
        return $out;
    }

    /** Score every candidate against the library row and return them sorted best-first. */
    private function rankCandidates(PgLibrary $library, array $candidates): array
    {
        if (empty($candidates)) return [];

        $authors = array_filter(array_map('trim', explode(';', (string) $library->author)));
        $libMeta = [
            'title'     => $library->title,
            'authors'   => array_values($authors),
            'year'      => $library->year,
            'journal'   => $library->journal,
            'publisher' => $library->publisher,
        ];

        $scored = [];
        foreach ($candidates as $normalised) {
            $score = (float) ($this->openAlex->metadataScore($libMeta, $normalised)['score'] ?? 0);
            $scored[] = ['normalised' => $normalised, 'score' => $score];
        }
        usort($scored, fn($a, $b) => $b['score'] <=> $a['score']);
        return $scored;
    }

    /** Present a stored canonical as a normalised-work-shaped candidate (carries the identifiers). */
    private function canonicalToCandidate(CanonicalSource $c): array
    {
        return [
            'title'               => $c->title,
            'author'              => $c->author,
            'year'                => $c->year,
            'journal'             => $c->journal,
            'publisher'           => $c->publisher,
            'abstract'            => $c->abstract,
            'type'                => $c->type,
            'language'            => $c->language,
            'doi'                 => $c->doi,
            'openalex_id'         => $c->openalex_id,
            'open_library_key'    => $c->open_library_key,
            'semantic_scholar_id' => $c->semantic_scholar_id,
            'is_oa'               => $c->is_oa,
            'oa_status'           => $c->oa_status,
            'oa_url'              => $c->oa_url,
            'pdf_url'             => $c->pdf_url,
            'work_license'        => $c->work_license,
            'cited_by_count'      => $c->cited_by_count,
            'source'              => 'canonical',
        ];
    }

    /** Build a candidate from a library row that already carries OpenAlex metadata (wave 2). */
    private function libraryRowAsCandidate(PgLibrary $library): array
    {
        return [
            'title'            => $library->title,
            'author'           => $library->author,
            'year'             => $library->year,
            'journal'          => $library->journal,
            'publisher'        => $library->publisher,
            'abstract'         => $library->abstract,
            'type'             => $library->type,
            'language'         => $library->language,
            'doi'              => $library->doi,
            'openalex_id'      => $library->openalex_id,
            'open_library_key' => $library->open_library_key ?? null,
            'is_oa'            => $library->is_oa,
            'oa_status'        => $library->oa_status,
            'oa_url'           => $library->oa_url ?? null,
            'pdf_url'          => $library->pdf_url ?? null,
            'work_license'     => $library->work_license ?? null,
            'cited_by_count'   => $library->cited_by_count,
            'source'           => 'openalex',
        ];
    }

    /** Map a normalised work's `source` to the canonical foundation_source provenance value. */
    private function foundationFromSource(?string $source): string
    {
        return match ($source) {
            // OpenLibraryService::normaliseDoc emits 'openlibrary' (no underscore); accept both so
            // OL-verified works aren't mislabelled openalex_ingest (which mis-attributes the provider).
            'openlibrary', 'open_library' => 'open_library_ingest',
            'semantic_scholar'            => 'semantic_scholar_ingest',
            default                       => 'openalex_ingest',
        };
    }

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
