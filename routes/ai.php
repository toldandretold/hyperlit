<?php

use Laravel\Mcp\Facades\Mcp;

/*
|--------------------------------------------------------------------------
| MCP (Model Context Protocol) servers
|--------------------------------------------------------------------------
|
| The Streamable-HTTP endpoint external AI clients connect to. Two ways in:
|
|   OAuth (claude.ai, Claude mobile, Claude Code — just add the URL as a
|   custom connector): a token-less request 401s, the vendor
|   AddWwwAuthenticateHeader points at the OAuth discovery metadata
|   (routes/oauth.php), and the client runs login+consent itself. The
|   access token it ends up holding is an ORDINARY Sanctum PAT.
|
|   Pasted personal access token (any client; minted via the user button →
|   "Data sovereignty" → "MCP for AI access" → "Connect an AI"):
|
|   claude mcp add --transport http hyperlit https://hyperlit.io/mcp \
|     --header "Authorization: Bearer <token>"
|
| McpOptionalAuth authenticates a valid bearer token (and repoints the
| default guard — load-bearing for every tool's $request->user()), and 401s
| everything else with a rich how-to-connect body — token-less 401s are
| REQUIRED for OAuth discovery (Claude only acts on WWW-Authenticate on a
| 401; a 200 guest handshake would read as "connected, no login needed").
| GUESTS still exist behind POST /mcp?guest=1: the handshake succeeds but
| only the get_connected onboarding tool shows — HyperlitTool::
| shouldRegister() hides the data toolset, and the empty RLS context
| (SetDatabaseSessionContext with no user) allows public reads only.
|
| Middleware ORDER is load-bearing and the declared order IS the execution
| order (only throttle:mcp sits in $middlewarePriority, and a single listed
| entry is never reordered): auth resolution first keeps the named 'mcp'
| limiter keyed per-user for token callers and makes guests share the IP
| bucket; SetDatabaseSessionContext last so the RLS vars (app.current_user)
| are set from the resolved user. throttle:mcp is a NAMED limiter (see the
| rate-limiters review gate): an agent doing bulk work must not share the
| inline per-user bucket with the user's own browser tab.
| The first path segment is reserved in config/reserved-routes.php.
*/

Mcp::web('/mcp', \App\Mcp\Servers\HyperlitServer::class)
    ->middleware([
        \App\Http\Middleware\McpOptionalAuth::class,
        'throttle:mcp',
        \App\Http\Middleware\SetDatabaseSessionContext::class,
    ]);
