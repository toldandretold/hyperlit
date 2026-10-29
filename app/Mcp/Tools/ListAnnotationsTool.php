<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListAnnotationsTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'list_annotations';

    protected string $description = 'List a book\'s hyperlights (highlights with annotations) and hypercites (citable anchors) that are visible to the user, with the highlighted text and note of each.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
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

        $result = InternalCall::call(
            DatabaseToIndexedDBController::class, 'getBookAnnotations',
            [], $this->user($request), [$bookId]
        );
        if ($error = $this->errorFrom($result, 'list annotations')) {
            return $error;
        }

        $username = $this->user($request)->name;

        $hyperlights = collect($result['json']['hyperlights'] ?? [])->map(fn ($h) => [
            'hyperlight_id' => $h['hyperlight_id'] ?? $h['highlightID'] ?? null,
            'highlighted_text' => $h['highlightedText'] ?? $h['highlighted_text'] ?? null,
            'annotation' => $h['annotation'] ?? null,
            'node_ids' => $h['node_id'] ?? [],
            'creator' => $h['creator'] ?? null,
            'is_mine' => ($h['creator'] ?? null) === $username,
            'hidden' => (bool) ($h['hidden'] ?? false),
        ])->all();

        $hypercites = collect($result['json']['hypercites'] ?? [])->map(fn ($h) => [
            'hypercite_id' => $h['hyperciteId'] ?? $h['hypercite_id'] ?? null,
            'hypercited_text' => $h['hypercitedText'] ?? $h['hypercited_text'] ?? null,
            'cited_in' => $h['citedIN'] ?? [],
            'node_ids' => $h['node_id'] ?? [],
        ])->all();

        return Response::json([
            'book' => $bookId,
            'hyperlights' => $hyperlights,
            'hypercites' => $hypercites,
        ]);
    }
}
