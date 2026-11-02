<?php

namespace App\Mcp\Tools;

use App\Mcp\TokenAbilities;
use App\Services\Annotations\AnnotationAnchorService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ReadBookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'read_book';

    protected string $description = 'Read a book\'s text as ordered nodes (paragraphs/headings), paginated. Returns plain text per node plus its node_id and startLine; quote this text VERBATIM when creating highlights. Resume with after_line from the previous response\'s next_after_line. Use get_book\'s table of contents to jump to a section (pass its node startLine as after_line, minus 1).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'after_line' => $schema->number()
                ->description('Return nodes with startLine GREATER than this. Omit to start from the beginning.'),
            'max_chars' => $schema->integer()
                ->description('Soft cap on returned text (default 25000, max 60000).'),
            'format' => $schema->string()->enum(['plain', 'html'])
                ->description('plain (default) = entity-decoded text, the coordinate space highlights anchor to; html = stored node HTML.'),
            'include_footnotes' => $schema->boolean()
                ->description('true = also return the definitions of footnotes referenced by the returned nodes (a footnotes map keyed by footnote id).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string']);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $afterLine = (float) $request->get('after_line', -INF);
        $maxChars = min(60_000, max(1_000, (int) $request->get('max_chars', 25_000)));
        $html = $request->get('format') === 'html';

        $nodes = $this->fetchNodes($bookId, $this->user($request));
        if ($nodes instanceof Response) {
            return $nodes;
        }
        $nodes = collect($nodes);

        $out = [];
        $chars = 0;
        $nextAfterLine = null;
        foreach ($nodes as $node) {
            $line = (float) ($node['startLine'] ?? 0);
            if ($line <= $afterLine) {
                continue;
            }
            $text = $html
                ? (string) ($node['content'] ?? '')
                : AnnotationAnchorService::plainOf($node['content'] ?? null);
            if ($out !== [] && $chars + mb_strlen($text) > $maxChars) {
                $nextAfterLine = $out[count($out) - 1]['startLine'];
                break;
            }
            $row = [
                'node_id' => $node['node_id'] ?? null,
                'startLine' => $node['startLine'],
                'text' => $text,
            ];
            $fns = $node['footnotes'] ?? [];
            if (is_string($fns)) {
                $fns = json_decode($fns, true) ?: [];
            }
            if ($fns !== []) {
                $row['footnote_ids'] = array_values($fns);
            }
            $out[] = $row;
            $chars += mb_strlen($text);
        }

        $response = [
            'book' => $bookId,
            'nodes' => $out,
            'total_nodes_in_book' => $nodes->count(),
            // null = you have reached the end of the book.
            'next_after_line' => $nextAfterLine,
        ];

        // Footnote definitions for the RETURNED nodes only (default/RLS
        // connection — same visibility as the book itself).
        if ($request->boolean('include_footnotes')) {
            $ids = array_values(array_unique(array_merge(
                ...array_map(fn ($r) => $r['footnote_ids'] ?? [], $out) ?: [[]]
            )));
            $response['footnotes'] = $ids === [] ? [] : \Illuminate\Support\Facades\DB::table('footnotes')
                ->where('book', $bookId)
                ->whereIn('footnoteId', $ids)
                ->pluck('content', 'footnoteId')
                ->map(fn ($c) => AnnotationAnchorService::plainOf($c))
                ->all();
        }

        return Response::json($response);
    }
}
