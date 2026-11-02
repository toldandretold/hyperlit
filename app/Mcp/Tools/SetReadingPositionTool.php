<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Sets the bookmark the reader restores to. The element id is a node's
 * positional id (startLine); the chunk is derived server-side from the node
 * row so the two can never disagree.
 */
#[IsIdempotent]
class SetReadingPositionTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'set_reading_position';

    protected string $description = 'Set the user\'s saved reading position in a book to a given node (from read_book output) — the reader will open there next time.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'node_id' => $schema->string()->required()->description('The data-node-id of the node to bookmark (from read_book).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string', 'node_id' => 'required|string']);
        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $node = DB::table('nodes')->where('book', $bookId)
            ->where('node_id', (string) $request->get('node_id'))
            ->first(['startLine', 'chunk_id']);
        if (! $node) {
            return Response::error('That node_id was not found in this book — copy it from read_book output.');
        }

        $result = InternalCall::call(DatabaseToIndexedDBController::class, 'saveReadingPosition', [
            'element_id' => (string) $node->startLine,
            'chunk_id' => (float) ($node->chunk_id ?? 0),
        ], $this->user($request), [$bookId]);
        if ($error = $this->errorFrom($result, 'save the position')) {
            return $error;
        }

        return Response::json([
            'book' => $bookId,
            'saved_at_node' => $request->get('node_id'),
            'startLine' => $node->startLine,
        ]);
    }
}
