<?php

use Laravel\Mcp\Facades\Mcp;

/*
|--------------------------------------------------------------------------
| MCP (Model Context Protocol) servers
|--------------------------------------------------------------------------
|
| The Streamable-HTTP endpoint external AI clients connect to with a
| personal access token (minted in the account panel's "AI access" row):
|
|   claude mcp add --transport http hyperlit https://hyperlit.io/mcp \
|     --header "Authorization: Bearer <token>"
|
| Middleware ORDER is load-bearing: auth:sanctum must run BEFORE
| SetDatabaseSessionContext so the RLS vars (app.current_user) are set from
| the token's user — /mcp is in neither the web nor the api group, so the
| context middleware is attached here explicitly. throttle:mcp is a NAMED
| limiter (see the rate-limiters review gate): an agent doing bulk work must
| not share the inline per-user bucket with the user's own browser tab.
| The first path segment is reserved in config/reserved-routes.php.
*/

Mcp::web('/mcp', \App\Mcp\Servers\HyperlitServer::class)
    ->middleware([
        'throttle:mcp',
        'auth:sanctum',
        \App\Http\Middleware\SetDatabaseSessionContext::class,
    ]);
