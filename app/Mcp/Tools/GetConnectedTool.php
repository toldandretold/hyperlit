<?php

namespace App\Mcp\Tools;

use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * The onboarding tool — the ONE tool a guest (token-less) connection sees,
 * and deliberately also available to authenticated callers (it then reports
 * who the token belongs to and what it can do, which is the natural answer
 * to "my token lacks X").
 *
 * Extends the vendor Tool directly, NOT HyperlitTool: it must not inherit
 * the authed-only shouldRegister gate or the ability check, and it touches
 * no user data either way.
 */
#[IsReadOnly]
class GetConnectedTool extends Tool
{
    protected string $name = 'get_connected';

    protected string $description = 'How to connect this Hyperlit account to an AI client: '
        .'where the user mints a personal access token in the web app, what each token '
        .'ability allows, and the exact client configuration. Call this when unauthenticated, '
        .'when a token is rejected, or when the user asks how to set up / upgrade MCP access. '
        .'Relay the steps to the user — they involve actions only a human in the browser can take.';

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    public function handle(Request $request): Response
    {
        $origin = rtrim(config('app.url'), '/');
        $user = $request->user();

        $walkthrough = <<<MARKDOWN
            ## Connecting an AI client to Hyperlit

            ### Easiest: OAuth (claude.ai, Claude mobile, Claude Desktop, Claude Code)

            Add {$origin}/mcp as a custom connector / MCP server with NO auth
            header. The client discovers Hyperlit's OAuth flow automatically and
            walks the user through login + consent in the browser; the resulting
            access token is managed (and revocable) in the web app under
            "Data sovereignty" → "MCP for AI access", like any other token.

            ### Manual: mint a personal access token

            Minting a token happens in the web app — relay these steps to the user:

            1. Go to {$origin} and log in (or register — it's free).
            2. Click your user button (top of the page), then "Data sovereignty".
            3. In the "MCP for AI access" section, click "Connect an AI".
            4. Name the token and pick its abilities:
               - read — library, search, book content, annotations, exports.
               - annotate — create highlights, hypercites, shelf changes.
               - import — import documents and URLs into the library.
               - write — edit and extend books the user owns.
               - spend — allow paid actions (e.g. PDF OCR) to charge their balance.
               - report — consent for the assistant to file bug reports with the
                 Hyperlit maintainer when an MCP tool malfunctions.
            5. Copy the token from the reveal box — it is shown exactly ONCE
               (the server stores only a hash). Tokens last up to 365 days.

            Then configure the client with the token as a bearer header:

            Claude Code:

                claude mcp add --transport http hyperlit {$origin}/mcp \
                  --header "Authorization: Bearer <token>"

            Generic MCP JSON config:

                {
                  "mcpServers": {
                    "hyperlit": {
                      "type": "http",
                      "url": "{$origin}/mcp",
                      "headers": { "Authorization": "Bearer <token>" }
                    }
                  }
                }

            Note: a token-less request to {$origin}/mcp gets a 401 (that is
            what triggers OAuth-capable clients to show the login). A client
            that wants the anonymous guest surface instead connects to
            {$origin}/mcp?guest=1.
            MARKDOWN;

        if (! $user instanceof User) {
            return Response::text(
                "You are connected to Hyperlit as a GUEST — no data tools are "
                ."available until a personal access token is supplied.\n\n".$walkthrough
            );
        }

        $token = $user->currentAccessToken();
        $status = $token instanceof PersonalAccessToken
            ? "You are authenticated as \"{$user->name}\" with token \"{$token->name}\" "
              .'carrying abilities: '.implode(', ', $token->abilities ?: []).'. '
              .'All of: '.implode(', ', TokenAbilities::all()).' exist.'
            : "You are authenticated as \"{$user->name}\" via a web session, which "
              .'passes every ability check.';

        return Response::text(
            $status."\n\nIf an ability is missing, the user mints a replacement "
            ."token with it enabled — same flow:\n\n".$walkthrough
        );
    }
}
