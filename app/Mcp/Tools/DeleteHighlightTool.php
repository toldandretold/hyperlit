<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbHyperlightController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[IsDestructive]
class DeleteHighlightTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'delete_highlight';

    protected string $description = 'Delete one of the user\'s hyperlights (mode=delete, permanent — the annotation goes with it), or just hide it from other readers (mode=hide, reversible via update_highlight).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'hyperlight_id' => $schema->string()->required()->description('The HL_… id to remove.'),
            'mode' => $schema->string()->enum(['delete', 'hide'])
                ->description('delete (default) = permanent; hide = stop showing it to other readers.'),
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
        ]);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $mode = $request->get('mode', 'delete') === 'hide' ? 'hide' : 'delete';
        $user = $this->user($request);
        $hyperlightId = (string) $request->get('hyperlight_id');

        // The controller SKIPS rows it refuses (missing / another user's) and
        // still answers success with no count — verify ownership up front so
        // a no-op can't masquerade as a deletion.
        $found = InternalCall::call(
            DbHyperlightController::class, 'find', [], $user, [$bookId, $hyperlightId]
        );
        $existing = $found['json']['hyperlight'] ?? null;
        if ($found['status'] !== 200 || ! $existing) {
            return Response::error('Highlight not found (or not visible to you).');
        }
        if (! ($existing['is_user_highlight'] ?? false)) {
            return Response::error('This highlight belongs to another user — only your own can be removed.');
        }

        $result = InternalCall::call(
            DbHyperlightController::class, $mode,
            ['data' => [['book' => $bookId, 'hyperlight_id' => $hyperlightId]]], $user
        );
        if ($error = $this->errorFrom($result, "{$mode} the highlight")) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? "The highlight was not {$mode}d.");
        }

        return Response::json(['hyperlight_id' => $hyperlightId, 'mode' => $mode, 'done' => true]);
    }
}
