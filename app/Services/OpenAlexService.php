<?php

namespace App\Services;

use App\Services\OpenAlex\CitationTextExtractor;
use App\Services\OpenAlex\LibraryStubWriter;
use App\Services\OpenAlex\OpenAlexHttpClient;
use App\Services\OpenAlex\WorkNormaliser;
use App\Services\OpenAlex\WorkScorer;
use App\Services\OpenAlex\WorksApi;

/**
 * Facade over the app/Services/OpenAlex/ modules. Every public method keeps
 * its original signature and delegates one-to-one, so the ~10 existing
 * callers (citation scan job, matchers, controllers) are untouched. New code
 * should prefer injecting the specific module it needs:
 *
 * - OpenAlexHttpClient  — transport, rate limiting, pooled batch loop
 * - WorksApi            — /works and /authors queries (normalised results)
 * - CitationTextExtractor — DOI / ISBN / title parsing from citation text
 * - WorkScorer          — titleSimilarity / metadataScore / isCitableWork
 * - WorkNormaliser      — raw work JSON → shared citation shape, BibTeX
 * - LibraryStubWriter   — library stub upserts (pgsql_admin)
 */
class OpenAlexService
{
    public const BASE_URL = OpenAlexHttpClient::BASE_URL;
    public const USER_AGENT = OpenAlexHttpClient::USER_AGENT;
    public const SELECT_FIELDS = OpenAlexHttpClient::SELECT_FIELDS;

    public function __construct(
        private WorksApi $works,
        private CitationTextExtractor $extractor,
        private WorkScorer $scorer,
        private WorkNormaliser $normaliser,
        private LibraryStubWriter $stubs,
    ) {
    }

    /** @see WorksApi::fetchFromOpenAlex() */
    public function fetchFromOpenAlex(string $query, int $limit = 10, int $page = 1, bool $userFacing = false, bool $throwOnFailure = false): array
    {
        return $this->works->fetchFromOpenAlex($query, $limit, $page, $userFacing, $throwOnFailure);
    }

    /** @see WorksApi::fetchFromOpenAlexByAuthor() */
    public function fetchFromOpenAlexByAuthor(string $query, int $limit = 10): array
    {
        return $this->works->fetchFromOpenAlexByAuthor($query, $limit);
    }

    /** @see WorksApi::fetchByDoi() */
    public function fetchByDoi(string $doi): ?array
    {
        return $this->works->fetchByDoi($doi);
    }

    /** @see WorksApi::fetchByDoiBatch() */
    public function fetchByDoiBatch(array $dois): array
    {
        return $this->works->fetchByDoiBatch($dois);
    }

    /** @see WorksApi::searchBatch() */
    public function searchBatch(array $queries, int $limit = 5, array $yearFilters = []): array
    {
        return $this->works->searchBatch($queries, $limit, $yearFilters);
    }

    /** @see WorksApi::fetchReferencedWorkIds() */
    public function fetchReferencedWorkIds(string $openalexId): array
    {
        return $this->works->fetchReferencedWorkIds($openalexId);
    }

    /** @see WorksApi::fetchByIdsBatch() */
    public function fetchByIdsBatch(array $openalexIds): array
    {
        return $this->works->fetchByIdsBatch($openalexIds);
    }

    /** @see CitationTextExtractor::extractDoi() */
    public function extractDoi(string $html): ?string
    {
        return $this->extractor->extractDoi($html);
    }

    /** @see CitationTextExtractor::extractIsbn() */
    public function extractIsbn(string $text): ?string
    {
        return $this->extractor->extractIsbn($text);
    }

    /** @see CitationTextExtractor::extractTitle() */
    public function extractTitle(string $raw): string
    {
        return $this->extractor->extractTitle($raw);
    }

    /** @see WorkScorer::titleSimilarity() */
    public function titleSimilarity(string $query, string $resultTitle): float
    {
        return $this->scorer->titleSimilarity($query, $resultTitle);
    }

    /** @see WorkScorer::metadataScore() */
    public function metadataScore(array $llmMeta, array $candidate): array
    {
        return $this->scorer->metadataScore($llmMeta, $candidate);
    }

    /** @see WorkScorer::isCitableWork() */
    public function isCitableWork(array $normalised): bool
    {
        return $this->scorer->isCitableWork($normalised);
    }

    /** @see WorkNormaliser::reconstructAbstract() */
    public static function reconstructAbstract(?array $invertedIndex): ?string
    {
        return WorkNormaliser::reconstructAbstract($invertedIndex);
    }

    /** @see WorkNormaliser::normaliseWork() */
    public function normaliseWork(array $work): array
    {
        return $this->normaliser->normaliseWork($work);
    }

    /** @see WorkNormaliser::generateBibtex() */
    public function generateBibtex(array $work): string
    {
        return $this->normaliser->generateBibtex($work);
    }

    /** @see LibraryStubWriter::upsertLibraryStubs() */
    public function upsertLibraryStubs(array $candidates): array
    {
        return $this->stubs->upsertLibraryStubs($candidates);
    }

    /** @see LibraryStubWriter::createOrFindStub() */
    public function createOrFindStub(array $normalised): ?string
    {
        return $this->stubs->createOrFindStub($normalised);
    }
}
