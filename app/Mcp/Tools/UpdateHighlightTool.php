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

    protected string $description = 'Update an existing hyperlight\'s annotation text, annotation visibility, or suggested edit. Cannot move the highlight to a different passage (delete and re-create for that); to hide it from other readers use delete_highlight with mode=hide. Only the user\'s own highlights can be updated.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'hyperlight_id' => $schema->string()->required()->description('The HL_… id (from list_annotations or create_highlight).'),
            'annotation' => $schema->string()->description('New annotation text (replaces the old note; empty string clears it).'),
            'visibility' => $schema->string()->enum(['public', 'private'])->description('New annotation visibility.'),
            'suggested_replacement' => $schema->string()
                ->description('Propose (or revise) a suggested edit: this text replaces the highlighted passage if the book owner accepts. Single-paragraph highlights only. Passing text identical to the passage withdraws the suggestion.'),
            'withdraw_suggestion' => $schema->boolean()
                ->description('true = withdraw the pending suggested edit (leaves the highlight itself in place).'),
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
            'suggested_replacement' => 'nullable|string|max:20000',
            'withdraw_suggestion' => 'nullable|boolean',
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
        // NOTE: suggested_text / suggestion_status are deliberately ABSENT from
        // the merge base — the upsert guard preserves them when the keys are
        // missing, so an annotation/visibility edit never disturbs a pending
        // suggestion. They are added below only when the caller asked.

        $replacement = $request->get('suggested_replacement');
        $replacement = is_string($replacement) && trim($replacement) !== '' ? $replacement : null;
        $withdraw = (bool) $request->get('withdraw_suggestion');
        $suggestionStatus = $existing['suggestion_status'] ?? null;

        if ($replacement !== null || $withdraw) {
            if (in_array($suggestionStatus, ['accepted', 'rejected', 'liked'], true)) {
                return Response::error(
                    "This suggestion was already {$suggestionStatus} — a resolved suggestion is immutable. Create a new highlight with suggested_replacement to propose a further edit."
                );
            }
            if ($withdraw) {
                $record['suggested_text'] = null;
                $suggestionStatus = null;
            } else {
                $nodeIds = $existing['node_id'] ?? [];
                if (count($nodeIds) !== 1) {
                    return Response::error(
                        'This highlight spans '.count($nodeIds).' paragraphs — suggested edits anchor to ONE paragraph. Create a single-paragraph highlight with suggested_replacement instead.'
                    );
                }
                // Keep the ORIGINAL before-snapshot on re-edit — it means "what
                // the suggester was responding to", not "the latest passage".
                $before = $existing['suggested_text'][$nodeIds[0]]['before']
                    ?? ($existing['highlightedText'] ?? '');
                if ($replacement === $before) {
                    // Mirror the client editor: an identical "replacement" is a withdrawal.
                    $record['suggested_text'] = null;
                    $suggestionStatus = null;
                } else {
                    $record['suggested_text'] = [$nodeIds[0] => ['before' => $before, 'after' => $replacement]];
                    $suggestionStatus = 'pending';
                }
            }
        }

        $result = InternalCall::call(
            DbHyperlightController::class, 'upsert', ['data' => [$record]], $user
        );
        if ($error = $this->errorFrom($result, 'update the highlight')) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? 'The highlight was not updated.');
        }

        return Response::json(array_filter([
            'hyperlight_id' => $hyperlightId,
            'updated' => true,
            'suggestion_status' => $suggestionStatus,
        ], fn ($v) => $v !== null));
    }
}
