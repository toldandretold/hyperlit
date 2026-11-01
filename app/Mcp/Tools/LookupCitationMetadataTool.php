<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\OpenAlexController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Resolve a raw citation string to authoritative bibliographic metadata via
 * OpenAlex (title, authors, year, DOI, venue). Read-only and free — the model
 * picks the best candidate and applies it with set_book_metadata. This is the
 * MCP equivalent of the reader's "fill citation details from the text" button.
 */
#[IsReadOnly]
class LookupCitationMetadataTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'lookup_citation_metadata';

    protected string $description = 'Resolve a raw citation / reference string to authoritative metadata via OpenAlex. Returns up to 3 candidates (title, authors, year, DOI, venue). Use it to fill in a book\'s citation details accurately, then apply the chosen one with set_book_metadata.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'citation' => $schema->string()->min(5)->required()
                ->description('A raw citation string, e.g. "Mwema, E., Birhane, A. (2024). Undersea cables in Africa. First Monday 29(4)."'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['citation' => 'required|string|min:5']);

        $result = InternalCall::call(OpenAlexController::class, 'lookupCitation', [
            'raw' => (string) $request->get('citation'),
        ], $this->user($request));

        $json = is_array($result['json']) ? $result['json'] : [];
        if (($json['success'] ?? false) !== true) {
            return Response::error($json['message'] ?? 'Citation lookup failed.');
        }

        $candidates = collect($json['candidates'] ?? [])->map(fn ($c) => [
            'title' => $c['title'] ?? $c['display_name'] ?? null,
            'authors' => $c['authors'] ?? $c['author'] ?? null,
            'year' => $c['year'] ?? $c['publication_year'] ?? null,
            'doi' => $c['doi'] ?? null,
            'venue' => $c['venue'] ?? $c['journal'] ?? $c['host_venue'] ?? null,
            'type' => $c['type'] ?? null,
        ])->all();

        return Response::json([
            'extracted_title' => $json['extracted_title'] ?? null,
            'candidates' => $candidates,
            'note' => 'Pick the best match and apply it with set_book_metadata. If none fit, infer the details from the text yourself.',
        ]);
    }
}
