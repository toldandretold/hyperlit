<?php

namespace App\Mcp\Tools;

use App\Mcp\TokenAbilities;
use App\Services\Connections\ConnectionCountQuery;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * The homepage discovery feeds. Ranking delegates to ConnectionCountQuery —
 * the ONE definition of connectedness (review gate: never re-derive a count
 * locally, never rank on the superseded total-citations column; even NAMING
 * that column here trips the gate's source scan, hence the hyphen).
 */
#[IsReadOnly]
class ListFeedTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'list_feed';

    protected string $description = 'The public discovery feeds: sort=recent (newest books), connected (most cited/citing — the docuverse ranking), or lit (most human annotation). Returns compact book rows with ids for get_book/read_book.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'sort' => $schema->string()->enum(['recent', 'connected', 'lit'])->required()->description('Which feed.'),
            'limit' => $schema->integer()->description('Max books (default 20, max 50).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['sort' => 'required|in:recent,connected,lit']);
        $limit = max(1, min(50, (int) $request->get('limit', 20)));
        $sort = (string) $request->get('sort');

        // Default (RLS) connection: public books plus the user's own. Root
        // books with readable content only — the same universe the homepage
        // feeds draw from.
        $items = DB::table('library')
            ->whereRaw("book NOT LIKE '%/%'")
            ->where('visibility', 'public')
            ->where('has_nodes', true)
            ->get(['book', 'title', 'author', 'year', 'creator', 'created_at',
                'hypercite_connections', 'reference_connections', 'total_highlights']);

        $sorted = match ($sort) {
            'connected' => ConnectionCountQuery::sortConnected($items),
            'lit' => ConnectionCountQuery::sortLit($items),
            default => $items->sortByDesc('created_at'),
        };

        $rows = $sorted->take($limit)->values()->map(fn ($b) => [
            'book' => $b->book,
            'title' => $b->title,
            'author' => $b->author,
            'year' => $b->year,
            'creator' => $b->creator,
            'hypercite_connections' => (int) ($b->hypercite_connections ?? 0),
            'reference_connections' => (int) ($b->reference_connections ?? 0),
            'total_highlights' => (int) ($b->total_highlights ?? 0),
        ]);

        return Response::json(['sort' => $sort, 'books' => $rows, 'count' => $rows->count()]);
    }
}
