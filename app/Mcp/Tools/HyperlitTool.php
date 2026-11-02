<?php

namespace App\Mcp\Tools;

use App\Helpers\BookSlugHelper;
use App\Models\User;
use App\Services\E2ee\EncryptedBookGuard;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * Base class for Hyperlit MCP tools: token-ability enforcement, book
 * resolution + E2EE refusal, and response size budgeting.
 *
 * Every concrete tool declares its required ability
 * (App\Mcp\TokenAbilities) and starts handle() with:
 *
 *     if ($denied = $this->denyUnlessAble($request)) return $denied;
 */
abstract class HyperlitTool extends Tool
{
    /** One of TokenAbilities::* — checked against the caller's token. */
    protected string $ability = 'read';

    /**
     * Data tools exist only for authenticated callers. A GUEST (no bearer
     * token — McpOptionalAuth lets those through) sees none of them in
     * tools/list, and laravel/mcp filters tools/call through the same
     * registration check, so a guest calling one gets a clean JSON-RPC
     * "tool not found". The guest surface is GetConnectedTool, which
     * extends the vendor Tool directly for exactly this reason.
     *
     * ABILITY-SIZED LISTING: a personal access token also only SEES the tools
     * its abilities allow — a read-only token gets ~25 tools, not 47 refusing
     * ones. The visible list is the capability map, so an agent never plans
     * around a tool it cannot call, and the token-minting checkboxes become
     * the user's way of sizing the agent's tool surface. A session caller
     * (TransientToken) sees everything; denyUnlessAble stays as the
     * defense-in-depth call-time gate.
     */
    public function shouldRegister(\Illuminate\Http\Request $request): bool
    {
        $user = $request->user('sanctum');
        if ($user === null) {
            return false;
        }

        $token = $user->currentAccessToken();

        return ! $token instanceof PersonalAccessToken || $token->can($this->ability);
    }

    /**
     * Keep tool results safely inside client-side caps (~25K tokens in
     * Claude Code). Prose at ~4 chars/token → ~80K chars with headroom.
     */
    protected const CHAR_BUDGET = 80_000;

    /**
     * Ability gate. A session-authenticated caller (TransientToken) passes
     * everything; a personal access token must carry the tool's ability.
     */
    protected function denyUnlessAble(Request $request): ?Response
    {
        $user = $request->user();

        if (! $user instanceof User) {
            return Response::error(
                'Unauthenticated. Call get_connected for the steps to mint a '.
                'personal access token, then send it as "Authorization: Bearer <token>".'
            );
        }

        $token = $user->currentAccessToken();
        if ($token instanceof PersonalAccessToken && ! $token->can($this->ability)) {
            return Response::error(
                "This token lacks the '{$this->ability}' ability. ".
                'The user can mint a token with it via the user button → '
                .'Data sovereignty → MCP for AI access → Connect an AI.'
            );
        }

        return null;
    }

    protected function user(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }

    /**
     * Resolve a book id or slug to the canonical id, refusing E2EE books.
     * Returns [resolvedId, null] or [null, errorResponse].
     *
     * @return array{0: ?string, 1: ?Response}
     */
    protected function resolveBook(string $bookOrSlug): array
    {
        $bookId = BookSlugHelper::resolve(trim($bookOrSlug));

        if (EncryptedBookGuard::isEncrypted($bookId)) {
            return [null, Response::error(
                'This book is end-to-end encrypted: its content never reaches the '.
                'server in readable form, so it cannot be read or annotated here. '.
                'The user can work with it in the Hyperlit app, where decryption '.
                'happens on their device.'
            )];
        }

        return [$bookId, null];
    }

    /**
     * All of a book's nodes in reading order (authorization enforced by the
     * controller), or an error Response.
     *
     * @return array<int, array<string, mixed>>|Response
     */
    protected function fetchNodes(string $bookId, User $user): array|Response
    {
        $result = \App\Mcp\Support\InternalCall::call(
            \App\Http\Controllers\DatabaseToIndexedDBController::class, 'getBookDataBatch',
            ['from' => 0], $user, [$bookId]
        );
        if ($error = $this->errorFrom($result, 'read this book')) {
            return $error;
        }

        return collect($result['json']['nodes'] ?? [])
            ->sortBy(fn ($n) => (float) ($n['startLine'] ?? 0))
            ->values()
            ->all();
    }

    /**
     * The most recent citation-review pipeline row for a book, ANY status
     * (pending/running/paused/failed/completed), via the BYPASSRLS admin
     * connection — same source CitationScannerController reads. Null if none.
     * `pipelineRunning` only exposes ACTIVE pipelines, so the review tools use
     * this to also see a paused/failed one (resumable state).
     */
    protected function latestPipeline(string $bookId): ?object
    {
        return \Illuminate\Support\Facades\DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('book', $bookId)
            ->orderByDesc('created_at')
            ->first();
    }

    /**
     * Map an in-process controller result (see InternalCall) to an error
     * Response when it failed, else null.
     */
    protected function errorFrom(array $result, string $action): ?Response
    {
        $status = $result['status'];
        if ($status < 400) {
            return null;
        }

        $message = is_array($result['json'])
            ? ($result['json']['message'] ?? $result['json']['error'] ?? null)
            : null;

        return match (true) {
            $status === 404 => Response::error("Book not found (while trying to {$action})."),
            $status === 403 => Response::error("Not authorized to {$action} — the book may be private and owned by someone else."),
            $status === 402 => Response::error($message ?? "Insufficient credit balance to {$action}."),
            $status === 410 => Response::error('This book has been deleted.'),
            default => Response::error($message ?? "Failed to {$action} (HTTP {$status})."),
        };
    }
}
