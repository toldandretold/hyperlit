<?php

namespace App\Services\CitationPipeline\Resolution;

use App\Services\OpenAlexService;

/**
 * The shared machinery a wave needs from the job it was extracted out of.
 *
 * Fourteen methods and six properties on `CitationScanBibliographyJob` are called from inside the
 * wave region. Those are the real coupling — not the local variables — and they cannot all move at
 * once without turning one reviewable refactor into a rewrite. So the job implements this
 * interface, waves depend on the interface, and it grows one method at a time as each wave moves.
 *
 * This is scaffolding, deliberately. As waves land, the helpers here should migrate into proper
 * collaborators (scoring, pool surgery, persistence) and this interface should SHRINK. If it is
 * still fourteen methods wide when the last wave has moved, the extraction has relocated the
 * monolith rather than dissolved it.
 */
interface ResolutionHost
{
    /**
     * Turn a normalised external record into a persisted resolution, or null if it was refused.
     *
     * Returns the `$results` row the caller records; also the place a printed URL can DEFER a
     * match so Wave 6 gets first refusal on it.
     */
    public function resolveWithNormalised(
        array $poolItem,
        array $normalised,
        string $matchMethod,
        ?float $score,
        OpenAlexService $openAlex,
        mixed $db,
        ?array $matchDiagnostics = null,
        bool $allowUrlDeferral = true,
    ): ?array;

    /**
     * Drop a resolved citation and everything tied to it from the pool.
     *
     * Not a simple unset: it also records a sub-citation's outcome against its parent, so a wave
     * that removed an entry by hand would silently lose that. `{refId}::subN` entries traverse the
     * whole ladder as first-class pool members.
     */
    public function removeRelatedPoolEntries(array &$pool, string $resolvedRefId, mixed $db, ?string $stubBookId = null): void;

    /**
     * Title floor: a candidate whose TITLE component is weak is refused no matter how high the
     * composite score — author + journal fuzz can drag a same-author-different-work candidate
     * over the composite threshold ("Peer review" → "Credibility, peer review, and Nature,
     * 1945–1990", titleScore 0.24, composite 0.41, both by Melinda Baldwin). A wrong link is
     * worse than no link.
     *
     * Both scoring gates below are destined for a `CandidateScorer` collaborator once the search
     * waves have all moved — they are here so the waves can move one at a time first.
     */
    public function hasTitleConfidence(?array $diagnostics, float $score): bool;

    /**
     * A sub-0.6 candidate whose publication year contradicts the citation's is a near-miss, not
     * a match; high scorers pass through (editions and reprints legitimately move the year).
     */
    public function hasYearMismatchRejection(?array $llmMeta, array $candidate, float $score): bool;

    /**
     * At least author OR year must corroborate the candidate. The shortened-title retries demand
     * this on top of the score, because chopping a subtitle raises similarity for every work
     * sharing the main title — the extra witness is what keeps the retry from being a downgrade.
     */
    public function hasAuthorOrYearConfirmation(?array $llmMeta, array $candidate): bool;

    /**
     * Fuzzy title(+metadata) match against the local `library` table; fills `$nearMiss` with the
     * best sub-threshold candidate when nothing clears the bar.
     */
    public function searchLibraryTable(string $title, ?array $llmMetadata, OpenAlexService $openAlex, mixed $db, ?array &$nearMiss = null): ?array;

    /**
     * URL-first: when the citation PRINTS an address, a library title match is parked so the
     * printed-URL wave gets first refusal. Returns true when the match was deferred — the caller
     * must then leave the entry in the pool. The parked match cannot be lost: it is applied
     * before any search money is spent if the URL yields nothing carrying article text.
     */
    public function deferLibraryMatchForPrintedUrl(string $refId, array $item, array $localMatch): bool;

    /** Write resolution columns onto the citation's own row (bibliography or footnotes). */
    public function updateSourceEntry(mixed $db, string $refId, array $data): void;

    /** The canonical_source_id column carry-through for a matched library row. */
    public function canonicalColumnFor(?string $canonicalId): array;

    /**
     * The scanned book's own OpenAlex work id (canonical's, else the library row's) — the key
     * into the referenced_works closed pool. Null when the book has no OpenAlex identity.
     */
    public function parentWorkOpenAlexId(mixed $db): ?string;

    /** Resolve a citation to a freshly-minted web/PDF stub (match_method web_fetch / brave_search). */
    public function resolveWithStub(array $poolItem, string $stubBookId, string $matchMethod, mixed $db): array;

    /**
     * The URL-first stashes. Library matches parked by deferLibraryMatchForPrintedUrl, and
     * title-search matches parked by resolveWithNormalised, both waiting for the printed URL to
     * be ASSESSED. The fallback wave consumes them after the printed-URL fetch has had first
     * refusal — kept as two maps because a parked library match re-runs the library write while
     * a parked normalised match goes back through resolveWithNormalised.
     *
     * @return array<string, array> refId => stash
     */
    public function urlDeferredLibraryMatches(): array;

    /** @return array<string, array{normalised: array, matchMethod: string, score: ?float, diagnostics: ?array}> */
    public function urlDeferredMatches(): array;

    /**
     * Did this fetch actually READ the article? A parked library match is only surrendered to a
     * grade in this set (or a staged PDF) — `isResolved` is any non-null text, so without this a
     * 400-character "Subscribe now" teaser would evict a real library copy of the work.
     */
    public function gradeCarriesArticleText(?string $grade): bool;
}
