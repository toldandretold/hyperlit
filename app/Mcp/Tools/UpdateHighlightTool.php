<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbHyperlightController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

#[IsIdempotent]
class UpdateHighlightTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'update_highlight';

    protected string $description = 'Update an existing hyperlight\'s annotation text or annotation visibility. Cannot move the highlight to a different passage (delete and re-create for that); to hide it from other readers use delete_highlight with mode=hide. Only the user\'s own highlights can be updated.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'hyperlight_id' => $schema->string()->required()->description('The HL_… id (from list_annotations or create_highlight).'),
            'annotation' => $schema->string()->description('New annotation text (replaces the old note; empty string clears it).'),
            'visibility' => $schema->string()->enum(['public', 'private'])->description('New annotation visibility.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'book' => 'required|string',
            'hyperlight_id' => ['required', 'string', 'regex:/^HL_[A-Za-z0-9]+$/'],
            'visibility' => 'nullable|in:public,private',
        ]);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $user = $this->user($request);
        $hyperlightId = (string) $request->get('hyperlight_id');

        // Fetch the existing record — the upsert's update arm overwrites every
        // column from the payload, so the merge base must be complete.
        $found = InternalCall::call(
            DbHyperlightController::class, 'find', [], $user, [$bookId, $hyperlightId]
        );
        $existing = $found['json']['hyperlight'] ?? null;
        if ($found['status'] !== 200 || ! $existing) {
            return Response::error('Highlight not found (or not visible to you).');
        }
        if (! ($existing['is_user_highlight'] ?? false)) {
            return Response::error('This highlight belongs to another user — only your own can be updated.');
        }

        $record = [
            'book' => $bookId,
            'hyperlight_id' => $hyperlightId,
            'node_id' => $existing['node_id'] ?? [],
            'charData' => $existing['charData'] ?? [],
            'highlightedText' => $existing['highlightedText'] ?? null,
            'highlightedHTML' => $existing['highlightedHTML'] ?? null,
            'preview_nodes' => $existing['preview_nodes'] ?? null,
            'startLine' => $existing['startLine'] ?? null,
            'time_since' => $existing['time_since'] ?? now()->getTimestamp(),
            'annotation' => $request->has('annotation')
                ? CreateHighlightTool::annotationHtml($request->get('annotation'))
                : ($existing['annotation'] ?? null),
            'sub_book_visibility' => $request->get('visibility', $existing['sub_book_visibility'] ?? 'public'),
        ];

        $result = InternalCall::call(
            DbHyperlightController::class, 'upsert', ['data' => [$record]], $user
        );
        if ($error = $this->errorFrom($result, 'update the highlight')) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? 'The highlight was not updated.');
        }

        return Response::json(['hyperlight_id' => $hyperlightId, 'updated' => true]);
    }
}
