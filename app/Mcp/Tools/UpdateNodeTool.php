<?php

namespace App\Mcp\Tools;

use App\Mcp\Support\BookContentWriter;
use App\Mcp\TokenAbilities;
use App\Services\DocumentImport\FileHelpers;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Replace one node's content in a book the user owns. Positional identity
 * (startLine / chunk_id / node_id) is NEVER taken from the caller — the node
 * keeps its place; only the content changes. The write rides unified-sync, so
 * the sanitizer, E2EE backstop, 409 stale check, server-side annotation
 * relocation and the nodes_history snapshot (restorability) all apply.
 */
#[IsIdempotent]
class UpdateNodeTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::WRITE;

    protected string $name = 'update_node';

    protected string $description = 'Replace the content of ONE node (paragraph/heading) in a book you own. Pass the node\'s data-node-id (from read_book) and the new content as a single HTML block element (e.g. <p>…</p>, <h2>…</h2>, <blockquote>…</blockquote>); bare text is wrapped in <p>. The node keeps its position; annotations on it are relocated server-side and every edit is versioned (restorable).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug — must be a book you own.'),
            'node_id' => $schema->string()->required()->description('The data-node-id of the node to replace (from read_book output).'),
            'content' => $schema->string()->min(1)->required()
                ->description('The node\'s new content: ONE HTML block element. Bare text gets wrapped in <p>.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'book' => 'required|string',
            'node_id' => 'required|string',
            'content' => 'required|string|min:1',
        ]);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $user = $this->user($request);
        if (! BookContentWriter::ownsBook($user, $bookId)) {
            return Response::error('You can only edit nodes in a book you own.');
        }

        // Clock captured BEFORE the node read: a write landing between this
        // read and ours (e.g. a concurrent cite_passage splicing an arrow
        // into this very node) must 409, not be silently overwritten. No
        // auto-retry here — unlike cite_passage's mechanical re-splice, this
        // content was authored against the stale read, so the agent has to
        // re-read and decide.
        $baseTimestamp = BookContentWriter::currentTimestamp($bookId);
        $node = BookContentWriter::nodeRow($bookId, (string) $request->get('node_id'));
        if (! $node) {
            return Response::error('That node_id was not found in this book — copy it from read_book output.');
        }

        $content = trim((string) $request->get('content'));
        if (! preg_match('/^<[a-z][a-z0-9]*[\s>]/i', $content)) {
            $content = '<p>'.$content.'</p>';
        }
        // Re-stamp the positional id + data-node-id the renderer relies on —
        // whatever the model put (or forgot) on the outer tag.
        $content = app(FileHelpers::class)->ensureNodeIdInContent(
            $content,
            // The positional id is decimal-capable ("100.5") — never truncate it.
            (string) $node->startLine,
            (string) $node->node_id,
        );

        $write = BookContentWriter::sync(
            $user,
            $bookId,
            [BookContentWriter::nodeItemFrom($node, $content)],
            [],
            $baseTimestamp,
        );
        if (! $write['ok']) {
            return Response::error($write['error']);
        }

        return Response::json([
            'book' => $bookId,
            'node_id' => $node->node_id,
            'url' => rtrim(config('app.url'), '/').'/'.$bookId.'#'.$node->startLine,
            'message' => 'Node updated. Annotations on it were relocated server-side; the previous version is restorable.',
        ]);
    }
}
