<?php

namespace App\Mcp\Tools;

use App\Mcp\TokenAbilities;
use App\Services\OpenAlexService;
use App\Services\OpenLibraryService;
use App\Services\SemanticScholarService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Discover scholarly works across the external bibliographic databases
 * Hyperlit already integrates — OpenAlex, Open Library, Semantic Scholar —
 * through their EXISTING clients (so the backoff/throttle/polite-pool logic is
 * reused, not re-implemented). All free/keyless. Use the interactive fast
 * paths (userFacing / failFast) so the model isn't blocked by sleep-backoff.
 */
#[IsReadOnly]
class SearchSourcesTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'search_sources';

    protected string $description = 'Search external scholarly databases for works (OpenAlex, Open Library, Semantic Scholar). Returns normalized candidates (title, authors, year, venue, DOI, open-access info). Use to identify/resolve a reference, find a work\'s metadata, or discover papers before importing. For a free full-text copy of a known DOI use find_full_text; to resolve a raw citation string use lookup_citation_metadata.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->min(2)->required()->description('Title / keywords / author to search for.'),
            'source' => $schema->string()->enum(['openalex', 'openlibrary', 'semantic_scholar', 'all'])
                ->description('Which database(s). Default openalex. "openlibrary" for books, "all" to merge.'),
            'limit' => $schema->integer()->description('Max results per source (default 8, max 20).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['query' => 'required|string|min:2']);
        $query = (string) $request->get('query');
        $limit = min(20, max(1, (int) $request->get('limit', 8)));
        $source = $request->get('source', 'openalex');
        $sources = $source === 'all' ? ['openalex', 'openlibrary', 'semantic_scholar'] : [$source];

        $results = [];
        foreach ($sources as $s) {
            try {
                $rows = match ($s) {
                    'openalex' => app(OpenAlexService::class)->fetchFromOpenAlex($query, $limit, 1, true),
                    'openlibrary' => app(OpenLibraryService::class)->search($query, null, $limit),
                    'semantic_scholar' => app(SemanticScholarService::class)->search($query, null, $limit, true),
                    default => [],
                };
            } catch (\Throwable $e) {
                // A single source failing must not sink the whole search.
                continue;
            }
            foreach ($rows as $r) {
                $results[] = $this->shape($r, $s);
            }
        }

        return Response::json([
            'query' => $query,
            'sources' => $sources,
            'count' => count($results),
            'results' => $results,
        ]);
    }

    /** @param array<string,mixed> $r */
    private function shape(array $r, string $source): array
    {
        return array_filter([
            'source' => $r['source'] ?? $source,
            'title' => $r['title'] ?? null,
            'authors' => $r['author'] ?? null,
            'year' => $r['year'] ?? null,
            'venue' => $r['journal'] ?? null,
            'doi' => $r['doi'] ?? null,
            'openalex_id' => $r['openalex_id'] ?? null,
            'open_library_key' => $r['open_library_key'] ?? null,
            'semantic_scholar_id' => $r['semantic_scholar_id'] ?? null,
            'type' => $r['type'] ?? null,
            'is_open_access' => $r['is_oa'] ?? null,
            'oa_url' => $r['oa_url'] ?? null,
            'pdf_url' => $r['pdf_url'] ?? null,
        ], fn ($v) => $v !== null && $v !== '');
    }
}
