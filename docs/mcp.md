# MCP: connecting an AI client to Hyperlit

Hyperlit exposes a Model Context Protocol server over Streamable HTTP at `https://hyperlit.io/mcp` (`routes/ai.php`, server class `App\Mcp\Servers\HyperlitServer`). An external AI client connects one of two ways — via **OAuth** (claude.ai, the Claude mobile app, Claude Desktop, Claude Code: add the URL as a custom connector and log in when prompted) or with a hand-minted Sanctum personal access token sent as `Authorization: Bearer <token>` — and then acts AS that user: everything it creates is attributed to them and fenced by the same RLS context as their own browser. Both paths end in the SAME credential: the OAuth token endpoint mints an ordinary PAT, so abilities, RLS, revocation, and the token UI are identical regardless of how the client connected.

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

claude.ai / Claude mobile / Claude Desktop (OAuth — no token needed): Settings → Connectors → Add custom connector → paste `https://hyperlit.io/mcp`. The app opens Hyperlit's login + consent page; the user picks the abilities to grant (same checkboxes as the mint overlay) and approves. Claude Code also works token-less: `claude mcp add --transport http hyperlit https://hyperlit.io/mcp` and it will run the OAuth flow on first use.

Or with a hand-minted token — Claude Code:

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


## One page holds the whole toolset

`tools/list` must return every tool on the first page (`HyperlitServer::$defaultPaginationLength = 50`, overriding the vendor default of 15). Real clients do not reliably follow `nextCursor`: OpenCode's agent saw only the first 15 tools, concluded `import_document` "isn't available", and rewrote an EXISTING book to get itself a container — a truncated tool surface is an agent improvising around a hole, not a smaller feature set. The gate (`McpServerTest` "the DEFAULT tools/list holds the ENTIRE registry on one page") counts the registry by reflection and fails the moment the tool count outgrows the page. There is deliberately no `create_book` tool — `import_document` with Markdown `content` is how a new book is born, and the server instructions tell agents to STOP rather than repurpose an existing book if their client hides the tool.

## cite_passage: placement doctrine, arrow merging, and honest concurrency

The ↗ belongs to the exact claim it supports — the tool description instructs agents to set `after_text` ending at that clause, one arrow per claim, never piled at paragraph end (the web archivist enforces the same doctrine in `AiBrainController`). Mechanically backed two ways. First, NEVER two arrows in a row: a bare-arrow insert whose splice point touches an existing `open-icon` anchor is MERGED into it as ONE grouped arrow carrying a `data-cite-group` payload (the web pipeline's exact shape — `{t, s, q}` per member), the existing anchor id becomes the group id, and the new source row's `citedIN` points at it; `citeGroupPopover` is now registered for all reader surfaces so the chooser works inside ordinary books, not just archivist answers. An `insert_quote` citation never merges — the quoted text separates the arrows. Second, lost updates are impossible: the library content clock is captured AT the node read and passed to unified-sync as `base_timestamp`, so a concurrent write between read and transaction gets the honest 409 — and `cite_passage` then re-reads, re-splices (folding into the other write's arrow if they now touch) and retries, up to three times. Before this, parallel `cite_passage` calls on one node each read-spliced-wrote and the last writer won: three arrows vanished while every call reported success (OpenCode, 2026-11-01). `update_node` passes the read-time clock too but deliberately does NOT auto-retry — its content was authored against the stale read, so the agent must re-read and decide.

## Guest mode: opt-in via `?guest=1`, because token-less must 401 for OAuth

A BARE token-less POST to `/mcp` is a 401. That is deliberate and load-bearing: Claude's client starts its OAuth flow ONLY off a 401 whose `WWW-Authenticate` header names the protected-resource metadata — a 200 guest handshake reads as "connected, no login needed" and the user would never see a login. The 401 body (returned directly by `App\Http\Middleware\McpOptionalAuth`) explains all three ways in: `oauth` (let the client autodiscover), `hint` (mint a PAT in the web app), and `guest_mode` (retry as `POST /mcp?guest=1`).

With `?guest=1`, the old guest behaviour is intact: the agent completes the MCP handshake as a GUEST, gets guest-flavoured server instructions, and sees exactly one tool — `get_connected` (`App\Mcp\Tools\GetConnectedTool`), whose output is the full onboarding walkthrough to relay to the user (OAuth path first, the mint path, what each ability means, the client config snippets). Guests have NO data access: every data tool hides itself via `HyperlitTool::shouldRegister()` (which also fences `tools/call` — a guest calling one gets JSON-RPC "tool not found"), and the RLS context is empty (public reads only), though no registered guest tool touches data at all.

An INVALID, expired, or revoked bearer token is a different case and still 401s — silently downgrading a bad token to guest would make the agent conclude the token works. That 401 now also carries the OAuth discovery header, which is the silent-refresh path: an expired OAuth-minted PAT 401s, Claude reads `resource_metadata`, and refreshes without bothering the user.

## Middleware order (load-bearing)

`routes/ai.php` declares `[McpOptionalAuth, throttle:mcp, SetDatabaseSessionContext]`, and the declared order IS the execution order (only throttle sits in Laravel's `$middlewarePriority`, and a single listed entry is never moved). Auth resolution first keeps the named `mcp` limiter keyed per-user for token callers (guests share the IP bucket — anonymous probes are rate-limited, which bare `auth:sanctum` never achieved since it 401'd before the limiter ran), and the RLS context middleware must always see the resolved user. `McpOptionalAuth` MUST call `Auth::shouldUse('sanctum')` on success — tool code resolves `$request->user()` via the default guard, and omitting it silently breaks every tool.

## OAuth: a thin OAuth 2.1 layer whose access tokens are PATs

`routes/oauth.php` (required from `bootstrap/app.php`) implements the whole flow hand-rolled over Sanctum — deliberately NOT Laravel Passport and NOT the vendor `Mcp::oauthRoutes()` (which hard-requires Passport): no new dependency, no second auth guard, and the RLS-adapted token machinery (`HyperlitPersonalAccessToken`, `SetDatabaseSessionContext`'s sanctum fallback, `TokenAbilities` gating) is reused byte-identical because the token endpoint just mints a PAT.

The endpoints:

- `GET /.well-known/oauth-protected-resource[/{path}]` — RFC 9728 metadata (`MetadataController`). Its route NAME `mcp.oauth.protected-resource` is load-bearing: the vendor `AddWwwAuthenticateHeader` on `/mcp` checks for that name and decorates every 401 with `resource_metadata="…"`, which is the one signal Claude acts on.
- `GET /.well-known/oauth-authorization-server[/{path}]` — RFC 8414 metadata. Must keep advertising `code_challenge_methods_supported: ["S256"]` and `token_endpoint_auth_methods_supported: ["none"]` — Claude refuses to proceed without either.
- `POST /oauth/register` — RFC 7591 dynamic client registration, STATELESS: the `client_id` is an encrypted blob of `{client_name, redirect_uris}` (`App\Services\Oauth\ClientRegistry`), so there is no clients table and nothing for registration spam to grow. Redirect-URI policy: any https, plus http on loopback with any port (Claude Code binds an ephemeral port). An `APP_KEY` rotation invalidates client_ids; clients transparently re-register.
- `GET /oauth/authorize` + `POST /oauth/authorize/decision` — the login + consent page (`AuthorizationController`, `resources/views/oauth/authorize.blade.php`), the ONLY server-rendered auth UI besides reset-password. In the `web` group (session + CSRF). The validation ladder refuses on OUR page until both `client_id` and `redirect_uri` validate (open-redirect guard), then errors travel back the OAuth way. The consent form submits via fetch + JS navigation on purpose: CSP `form-action 'self'` blocks a plain form POST whose response 302s to claude.ai.
- `POST /oauth/token` — `authorization_code` (PKCE S256 verified, redirect_uri re-bound, single-use codes in the database cache via `AuthCodeStore`) and `refresh_token` grants (`TokenController`). Lifetimes: code 5 min; access token (the PAT, named "{Client} (OAuth)") 7 days; refresh token 60 days rotated on every use; family cap 365 days from consent, matching the mint overlay's max.

Scopes ARE `TokenAbilities` names (plus `offline_access` for refresh), and the consent checkboxes mirror the mint overlay's defaults — granted scopes become the PAT's abilities verbatim (`App\Services\Oauth\OauthScopes`). Refresh rotation stores only sha256 hashes in `oauth_refresh_tokens` (not RLS-restricted, same rationale as `personal_access_tokens`; pruned daily via `model:prune`); each rotation deletes the superseded PAT, and presenting a rotated refresh token again — or one whose PAT the user deleted in the UI — revokes the whole family, so a stolen or revoked connector cannot refresh itself back to life. Because the access token is a PAT, the "a PAT can never mint PATs" invariant covers OAuth tokens automatically, and revocation is just deleting the token under "MCP for AI access".

The stateless routes (metadata, register, token) are registered GROUPLESS — no session, no cookies, and crucially no CSRF, so nothing was added to the exemption list — with wildcard no-credentials CORS (`OauthCors`) and named limiters (`oauth-metadata` / `oauth-register` / `oauth-token` / `oauth-authorize`). Deployment note: Claude fetches the metadata with a 10-second timeout — a Cloudflare WAF challenge on `/.well-known/*` or `/oauth/*` kills the flow, so those paths may need a WAF skip rule.

Manual verification ladder: (1) `npx @modelcontextprotocol/inspector` against `https://hyperlit.test/mcp` exercises the complete DCR → PKCE → consent → token → refresh dance in a browser; (2) pre-deploy real-client test: `cloudflared tunnel` to the .test site, add the tunnel URL as a custom connector on claude.ai; (3) production: add `https://hyperlit.io/mcp` at claude.ai → Settings → Connectors (and on the phone app).

## Importing a work by DOI or OpenAlex id

`import_document`'s `url` is an IDENTIFIER, not a web address. A DOI or OpenAlex work id goes to `App\Services\SourceImport\SingleWorkImporter`, which runs the same open-access acquisition ladder the source harvester uses (`AutoVersionCreator` → `ContentFetchService`: Europe PMC JATS, every OA location from OpenAlex / Unpaywall / Semantic Scholar / Crossref / CORE, article HTML, browser lanes) in a queued `ImportWorkJob` on the `imports` lane. arXiv and Gutenberg keep their one-file fetchers. An ordinary web page is refused as `unrecognised_identifier` — the agent is told to fetch it and pass `content`.

- **What comes back** — `{import, status: queued}`; the agent polls `import_status` with that id. A work that is already readable returns at once with `already_in_hyperlit`.
- **Outcome `commons`** — the shared system version (creator `canonicalizer_v1`), also put on the user's private "Imported works" shelf.
- **Outcome `personal_copy`** — a private book the user owns, made by `PersonalCopyMaker` when `HostingPolicy` holds the system copy (its licence does not allow public hosting).
- **OCR is never spent unasked** — when the ladder lands a PDF the job stops at `awaiting_confirmation`; `import_status` returns the page count, the estimated cost and a `confirm_token`, and the confirm call (`import_document` with only that token) needs the `spend` ability. JATS and HTML lanes are free and never pause.
- **Failures say why** — `import_status` carries `reason` and `via` ("tried 3 OA locations"); a refusal names what was checked and links the source.

Before this, `url` called `UrlImportController`'s own fetcher, which trusted OpenAlex's `is_oa` alone, could only ever produce a PDF from OpenAlex's single `pdf_url`, and reported every failure as `URL import failed: <code>`. `find_full_text` is unchanged and is no longer a required step before importing.

## Tests

`tests/Feature/Mcp/McpServerTest.php` pins the guest surface (`?guest=1`), the rich 401 with OAuth discovery, and the authed flow end to end through the real middleware stack; `tests/Feature/Mcp/McpReportBugTest.php` pins the consent gating, rate limit, and mail for `report_bug`. `tests/Feature/Oauth/` pins the OAuth layer: metadata shape (`OauthMetadataTest`), DCR + redirect-URI policy (`OauthRegistrationTest`), the authorize ladder + consent (`OauthAuthorizeTest`), the full dance through to a working `/mcp` token with RLS isolation and the PAT invariants (`OauthTokenExchangeTest`), and rotation/reuse/revocation/expiry (`OauthRefreshTest`). The DOI / OpenAlex import path is pinned by the `url` cases in `tests/Feature/Mcp/McpImportExportToolsTest.php` and by `tests/Feature/Import/SingleWorkImportTest.php`. Run with `php artisan test --filter=Mcp` / `--filter=Oauth` (PHP suite, not `npm test`).
