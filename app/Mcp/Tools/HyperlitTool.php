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
            return Response::error('Unauthenticated.');
        }

        $token = $user->currentAccessToken();
        if ($token instanceof PersonalAccessToken && ! $token->can($this->ability)) {
            return Response::error(
                "This token lacks the '{$this->ability}' ability. ".
                'The user can mint a token with it under Account → AI access.'
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
