<?php

namespace App\Mcp\Tools;

use App\Mcp\Support\BookContentWriter;
use App\Mcp\TokenAbilities;
use App\Services\AiBrain\HtmlBlockSplitter;
use App\Services\DocumentImport\FileHelpers;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Append block content to the END of a book the user owns. All positional
 * identity is minted SERVER-SIDE with the import convention — a LineId is the
 * book's order, and letting a model guess startLines is how nodes get
 * destroyed (the PRE_CLEAR_DELETE class). The write rides unified-sync with a
 * library-timestamp bump, so readers and the prerender see it immediately.
 */
#[IsIdempotent(false)]
class AppendNodesTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::WRITE;

    protected string $name = 'append_nodes';

    protected string $description = 'Append content to the END of a book you own. Pass HTML block elements (<p>, <h1>–<h6>, <blockquote>, <ul>/<ol>, <pre>…); each top-level block becomes one node, with positions minted server-side. Use import_document to create a new book; use this to extend one. To add citation arrows, write plain prose here and wire each citation with cite_passage afterwards.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug — must be a book you own.'),
            'html' => $schema->string()->min(1)->required()
                ->description('One or more HTML block elements. Bare inline text is wrapped in <p>. Do NOT include hypercite arrows — use cite_passage for those.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'book' => 'required|string',
            'html' => 'required|string|min:1',
        ]);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $user = $this->user($request);
        if (! BookContentWriter::ownsBook($user, $bookId)) {
            return Response::error('You can only append to a book you own.');
        }

        $blocks = HtmlBlockSplitter::split((string) $request->get('html'));
        if ($blocks === []) {
            return Response::error('No block content found in html.');
        }

        // Positions continue from the real end of the book: floor(last)+100,
        // +100 per block (the same rule the editor's id generator applies to
        // appends). The chunk continues until it holds ~100 nodes.
        $last = DB::table('nodes')->where('book', $bookId)
            ->selectRaw('MAX("startLine"::numeric) AS max_line')
            ->value('max_line');
        $nextLine = $last !== null ? ((int) floor((float) $last)) + 100 : 100;

        $lastChunk = (int) (DB::table('nodes')->where('book', $bookId)->max('chunk_id') ?? 0);
        $inLastChunk = (int) DB::table('nodes')->where('book', $bookId)->where('chunk_id', $lastChunk)->count();

        $helpers = app(FileHelpers::class);
        $items = [];
        foreach ($blocks as $block) {
            if ($inLastChunk >= 100) {
                $lastChunk += 100;
                $inLastChunk = 0;
            }
            $nodeId = $helpers->generateNodeId($bookId);
            preg_match('/^<([a-z][a-z0-9]*)[\s>]/i', $block, $m);

            $items[] = [
                'book' => $bookId,
                'node_id' => $nodeId,
                'startLine' => $nextLine,
                'chunk_id' => $lastChunk,
                'content' => $helpers->ensureNodeIdInContent($block, $nextLine, $nodeId),
                'footnotes' => [],
                'type' => strtolower($m[1] ?? 'p'),
            ];
            $nextLine += 100;
            $inLastChunk++;
        }

        $write = BookContentWriter::sync($user, $bookId, $items);
        if (! $write['ok']) {
            return Response::error($write['error']);
        }

        return Response::json([
            'book' => $bookId,
            'appended' => count($items),
            'nodes' => array_map(fn ($i) => ['node_id' => $i['node_id'], 'startLine' => $i['startLine']], $items),
            'url' => rtrim(config('app.url'), '/').'/'.$bookId.'#'.$items[0]['startLine'],
            'message' => 'Appended '.count($items).' node(s) at the end of the book.',
        ]);
    }
}
