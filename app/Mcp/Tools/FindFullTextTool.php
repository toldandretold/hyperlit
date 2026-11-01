<?php

namespace App\Mcp\Tools;

use App\Mcp\TokenAbilities;
use App\Services\CoreService;
use App\Services\SemanticScholarService;
use App\Services\UnpaywallService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Find a FREE full-text (open-access) copy of a work by DOI, merging
 * Hyperlit's existing OA locators: Unpaywall, CORE, and Semantic Scholar.
 * Pairs with import_document — find an OA PDF/landing page, fetch its text,
 * then import. Free/keyless (Unpaywall needs only a contact email, already
 * configured server-side).
 */
#[IsReadOnly]
class FindFullTextTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'find_full_text';

    protected string $description = 'Find open-access full-text locations (PDF / landing page) for a work by DOI, across Unpaywall, CORE and Semantic Scholar. Returns a de-duplicated list of OA locations. Use it to get a free copy to then import (import_document) or read.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'doi' => $schema->string()->min(4)->required()->description('The DOI (bare, e.g. 10.5210/fm.v29i4.13637).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['doi' => 'required|string|min:4']);
        $doi = ltrim(trim((string) $request->get('doi')), '/');
        $doi = preg_replace('#^https?://(dx\.)?doi\.org/#i', '', $doi) ?? $doi;

        $locations = [];
        $seen = [];
        $add = function (array $rows, string $src) use (&$locations, &$seen) {
            foreach ($rows as $loc) {
                $pdf = $loc['pdf_url'] ?? null;
                $landing = $loc['landing_page_url'] ?? null;
                $key = $pdf ?: $landing;
                if (! $key || isset($seen[$key])) {
                    continue;
                }
                $seen[$key] = true;
                $locations[] = array_filter([
                    'pdf_url' => $pdf,
                    'landing_page_url' => $landing,
                    'host_type' => $loc['host_type'] ?? null,
                    'version' => $loc['version'] ?? null,
                    'license' => $loc['license'] ?? null,
                    'source' => $src,
                ], fn ($v) => $v !== null && $v !== '');
            }
        };

        try {
            $add(app(UnpaywallService::class)->oaLocations($doi), 'unpaywall');
        } catch (\Throwable) {
        }
        try {
            $add(app(CoreService::class)->oaLocations($doi), 'core');
        } catch (\Throwable) {
        }
        try {
            $ssPdf = app(SemanticScholarService::class)->openAccessPdfByDoi($doi);
            if ($ssPdf) {
                $add([['pdf_url' => $ssPdf, 'host_type' => null]], 'semantic_scholar');
            }
        } catch (\Throwable) {
        }

        return Response::json([
            'doi' => $doi,
            'count' => count($locations),
            'open_access_locations' => $locations,
            'note' => $locations === []
                ? 'No open-access copy found. The work may be paywalled — the user would need to supply the PDF.'
                : 'Fetch one of these and import_document it (content from the fetched text, or file_base64 for a PDF).',
        ]);
    }
}
