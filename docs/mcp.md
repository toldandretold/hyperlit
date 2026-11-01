# MCP: connecting an AI client to Hyperlit

Hyperlit exposes a Model Context Protocol server over Streamable HTTP at `https://hyperlit.io/mcp` (`routes/ai.php`, server class `App\Mcp\Servers\HyperlitServer`). An external AI client (Claude Code, Claude Desktop, any MCP library) authenticates with a Sanctum personal access token sent as `Authorization: Bearer <token>` and then acts AS that user — everything it creates is attributed to them and fenced by the same RLS context as their own browser.

## Minting a token

Tokens are minted only in the web app, by a logged-in human: user button → "Data sovereignty" → "MCP for AI access" → "Connect an AI" (`resources/js/components/apiTokens/apiTokensOverlay.ts`, `ApiTokenController` — session-only; a PAT can never mint PATs). The plaintext token is shown exactly once; max lifetime 365 days.

## Abilities

The checkbox list at mint time maps 1:1 to `App\Mcp\TokenAbilities`, and each tool declares the ability it needs (`HyperlitTool::$ability`, enforced by `denyUnlessAble`). The names are chosen to survive a future mapping onto OAuth scopes unchanged.

- **read** — library, search, book content, TOC, annotations, shelves, exports, import progress. Default on.
- **annotate** — hyperlight/hypercite CRUD, shelf writes. Default on.
- **import** — file and URL document imports (free formats). Default off.
- **write** — node edits in owned books, two-way hypercite completion. Default off.
- **spend** — anything that charges credits (PDF OCR confirm). Default off.
- **report** — CONSENT for the agent to file bug reports with the maintainer via `report_bug` when an MCP tool malfunctions. Default on; it is a consent gate, not a capability — without it the tool is not even registered for the session, and reports carry the username and token name (server-stamped, never trusted from the agent). Reports are rate-limited to 5/hour per user, logged (`grep "MCP bug report" storage/logs/laravel.log`), and emailed synchronously to `config('mail.maintainer_alert')` via `McpBugReportMail` — best-effort, because a bug report must never itself 500.

## Client configuration

Claude Code:

```
claude mcp add --transport http hyperlit https://hyperlit.io/mcp \
  --header "Authorization: Bearer <token>"
```

Generic MCP JSON config:

```json
{
  "mcpServers": {
    "hyperlit": {
      "type": "http",
      "url": "https://hyperlit.io/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

claude.ai's web custom connectors support only OAuth (no custom-header field), which Hyperlit does not offer yet — see "OAuth later" below.

## One page holds the whole toolset

`tools/list` must return every tool on the first page (`HyperlitServer::$defaultPaginationLength = 50`, overriding the vendor default of 15). Real clients do not reliably follow `nextCursor`: OpenCode's agent saw only the first 15 tools, concluded `import_document` "isn't available", and rewrote an EXISTING book to get itself a container — a truncated tool surface is an agent improvising around a hole, not a smaller feature set. The gate (`McpServerTest` "the DEFAULT tools/list holds the ENTIRE registry on one page") counts the registry by reflection and fails the moment the tool count outgrows the page. There is deliberately no `create_book` tool — `import_document` with Markdown `content` is how a new book is born, and the server instructions tell agents to STOP rather than repurpose an existing book if their client hides the tool.

## cite_passage: placement doctrine, arrow merging, and honest concurrency

The ↗ belongs to the exact claim it supports — the tool description instructs agents to set `after_text` ending at that clause, one arrow per claim, never piled at paragraph end (the web archivist enforces the same doctrine in `AiBrainController`). Mechanically backed two ways. First, NEVER two arrows in a row: a bare-arrow insert whose splice point touches an existing `open-icon` anchor is MERGED into it as ONE grouped arrow carrying a `data-cite-group` payload (the web pipeline's exact shape — `{t, s, q}` per member), the existing anchor id becomes the group id, and the new source row's `citedIN` points at it; `citeGroupPopover` is now registered for all reader surfaces so the chooser works inside ordinary books, not just archivist answers. An `insert_quote` citation never merges — the quoted text separates the arrows. Second, lost updates are impossible: the library content clock is captured AT the node read and passed to unified-sync as `base_timestamp`, so a concurrent write between read and transaction gets the honest 409 — and `cite_passage` then re-reads, re-splices (folding into the other write's arrow if they now touch) and retries, up to three times. Before this, parallel `cite_passage` calls on one node each read-spliced-wrote and the last writer won: three arrows vanished while every call reported success (OpenCode, 2026-11-01). `update_node` passes the read-time clock too but deliberately does NOT auto-retry — its content was authored against the stale read, so the agent must re-read and decide.

## Guest mode: the endpoint teaches you how to connect

An agent probing `/mcp` with NO Authorization header is not refused: it completes the MCP handshake as a GUEST, gets guest-flavoured server instructions, and sees exactly one tool — `get_connected` (`App\Mcp\Tools\GetConnectedTool`), whose output is the full onboarding walkthrough to relay to the user (the mint path above, what each ability means, the client config snippets). Guests have NO data access: every data tool hides itself via `HyperlitTool::shouldRegister()` (which also fences `tools/call` — a guest calling one gets JSON-RPC "tool not found"), and the RLS context is empty (public reads only), though no registered guest tool touches data at all.

An INVALID, expired, or revoked bearer token is a different case and still 401s — silently downgrading a bad token to guest would make the agent conclude the token works. The 401 body (returned directly by `App\Http\Middleware\McpOptionalAuth`) carries `hint` (where the user mints a fresh token) and `guest_mode` (retry header-less for the onboarding tool), alongside the usual envelope keys.

## Middleware order (load-bearing)

`routes/ai.php` declares `[McpOptionalAuth, throttle:mcp, SetDatabaseSessionContext]`, and the declared order IS the execution order (only throttle sits in Laravel's `$middlewarePriority`, and a single listed entry is never moved). Auth resolution first keeps the named `mcp` limiter keyed per-user for token callers (guests share the IP bucket — anonymous probes are rate-limited, which bare `auth:sanctum` never achieved since it 401'd before the limiter ran), and the RLS context middleware must always see the resolved user. `McpOptionalAuth` MUST call `Auth::shouldUse('sanctum')` on success — tool code resolves `$request->user()` via the default guard, and omitting it silently breaks every tool.

## OAuth later

laravel/mcp ships `Mcp::oauthRoutes()` (`.well-known/oauth-protected-resource`, `.well-known/oauth-authorization-server`, RFC 7591 dynamic client registration) but it hard-requires Laravel Passport, which is not installed. When that lands: install Passport, call `Mcp::oauthRoutes()`, publish and brand the consent view (`mcp-views` tag), tighten `config('mcp.redirect_domains')`, and map `TokenAbilities` onto scopes. Nothing here blocks it — the vendor `AddWwwAuthenticateHeader` decorates any 401 and auto-switches from `error="invalid_token"` to the OAuth `resource_metadata` discovery form the moment the oauth routes exist, and the rich-401 body from `McpOptionalAuth` keeps working alongside it.

## Tests

`tests/Feature/Mcp/McpServerTest.php` pins the guest surface, the rich 401, and the authed flow end to end through the real middleware stack; `tests/Feature/Mcp/McpReportBugTest.php` pins the consent gating, rate limit, and mail for `report_bug`. Run with `php artisan test --filter=Mcp` (PHP suite, not `npm test`).
