<?php

namespace RedTeam;

/**
 * Shared run state handed to every probe.
 *
 * Holds the target URL, the run options, a logger, and — crucially — two live
 * sessions used by the cross-tenant attacks:
 *
 *   - attacker:  the account we control and act as. The "evil user".
 *   - victim:    a second account whose data the attacker must NOT be able to
 *                reach. We register it, log in, plant a secret in it, then
 *                switch to the attacker and try to read/modify that secret.
 *
 * Both accounts are provisioned at runtime against the live target via the real
 * /api/register + /api/login endpoints (black-box — no DB access), so the suite
 * works against any environment. Their credentials use the configured marker
 * prefix so they're easy to find and purge afterwards (see README "Cleanup").
 */
class Context
{
    public HttpClient $attacker;
    public HttpClient $victim;
    public HttpClient $anon;          // fresh, never-authenticated client

    /** @var array<string,mixed> populated by bootstrapAccounts() */
    public array $attackerCreds = [];
    public array $victimCreds   = [];
    public array $victimSecret  = [];   // book id + planted secret string

    public bool $accountsReady = false;

    public function __construct(
        public string $target,
        public bool $aggressive,
        public string $marker,
        private $logSink,
    ) {
        $this->attacker = new HttpClient($target);
        $this->victim   = new HttpClient($target);
        $this->anon     = new HttpClient($target);
    }

    public function log(string $msg): void
    {
        ($this->logSink)($msg);
    }

    /**
     * Register + log in the attacker and victim accounts and prime CSRF cookies.
     * Returns true if at least the attacker is authenticated (some IDOR probes
     * need both; they degrade to INCONCLUSIVE if the victim couldn't be set up).
     */
    public function bootstrapAccounts(): bool
    {
        $this->anon->primeCsrf('/');

        $this->attackerCreds = $this->makeCreds('attacker');
        $this->victimCreds   = $this->makeCreds('victim');

        $attackerOk = $this->provision($this->attacker, $this->attackerCreds);
        $victimOk   = $this->provision($this->victim, $this->victimCreds);

        $this->accountsReady = $attackerOk;
        return $attackerOk;
    }

    private function makeCreds(string $role): array
    {
        $rand = bin2hex(random_bytes(4));
        return [
            'name'     => $this->marker . '_' . $role . '_' . $rand,
            'email'    => $this->marker . '_' . $role . '_' . $rand . '@redteam.local',
            'password' => 'Redteam!' . bin2hex(random_bytes(6)) . 'Aa1',
        ];
    }

    /** Register, then ensure we hold an authenticated session. */
    private function provision(HttpClient $client, array $creds): bool
    {
        $client->primeCsrf('/');

        // The register/login routes are throttled (10/min, 20/min). On a 429 —
        // common when the suite is re-run quickly — back off and retry so a
        // single legitimate run can still set up its accounts. Capped so we
        // never hang indefinitely; if still throttled we report it.
        $reg = $this->withThrottleBackoff(fn () => $client->postJson('/api/register', [
            'name'                  => $creds['name'],
            'email'                 => $creds['email'],
            'password'              => $creds['password'],
            'password_confirmation' => $creds['password'],
        ]));

        // Registration may auto-login, or may require email verification. Either
        // way, try an explicit login to be sure we hold a session cookie.
        $login = $this->withThrottleBackoff(fn () => $client->postJson('/api/login', [
            'email'    => $creds['email'],
            'password' => $creds['password'],
        ]));

        $check = $client->get('/api/auth-check');
        $body  = $check->json();
        $authed = is_array($body)
            ? (($body['authenticated'] ?? $body['isAuthenticated'] ?? $body['loggedIn'] ?? false) === true
               || !empty($body['user']))
            : false;

        $this->log(sprintf(
            "provision %s: register=%d login=%d authed=%s",
            $creds['name'],
            $reg->status,
            $login->status,
            $authed ? 'yes' : 'no'
        ));

        return $authed || $login->ok();
    }

    /**
     * Create a library row (a "book") owned by the given client's user and
     * return its id, or null on failure. Goes through the real author-guarded
     * upsert endpoint, so the owner is set server-side from the session.
     */
    public function createBook(HttpClient $client, string $visibility = 'private', string $title = 'redteam book'): ?string
    {
        // NOTE: /db/library/upsert is UPDATE-only (404 "Book not found" if absent);
        // creation goes through bulk-create, which takes `data` as an object.
        $book = $this->marker . '_book_' . bin2hex(random_bytes(5));
        $resp = $client->postJson('/api/db/library/bulk-create', [
            'data' => [
                'book'       => $book,
                'title'      => $title,
                'visibility' => $visibility,
                'timestamp'  => 1700000000,
            ],
        ]);
        return $resp->ok() ? $book : null;
    }

    /**
     * Write one node's HTML `content` into a book. Returns the raw Response.
     * node_id is GLOBALLY unique (node_chunks_node_id_unique), so the default is
     * randomised per call — a fixed id collides with leftover rows across runs.
     * Pass an explicit $nodeId when another write (e.g. a highlight) must target it.
     */
    public function writeNode(HttpClient $client, string $book, string $content, string $nodeId = ''): Response
    {
        $nodeId = $nodeId !== '' ? $nodeId : 'rt_n_' . bin2hex(random_bytes(5));
        return $client->postJson('/api/db/node-chunks/upsert', [
            'book' => $book,
            'data' => [[
                'book'       => $book,
                'node_id'    => $nodeId,
                'chunk_id'   => 1,
                'startLine'  => 1,
                'type'       => 'text',
                'content'    => $content,
                'plainText'  => strip_tags($content),
            ]],
        ]);
    }

    /** Read the consolidated book payload (nodes/annotations/etc.) as a Response. */
    public function readBookData(HttpClient $client, string $book): Response
    {
        return $client->get('/api/database-to-indexeddb/books/' . rawurlencode($book) . '/data');
    }

    /**
     * Run a request closure; if it comes back 429, wait for the limiter window
     * to roll over (honouring Retry-After when present) and retry. Total wait is
     * capped at ~130s across two retries so the run can't stall forever.
     *
     * @param callable():Response $fn
     */
    private function withThrottleBackoff(callable $fn): Response
    {
        $resp = $fn();
        $attempts = 0;
        while ($resp->status === 429 && $attempts < 2) {
            $retryAfter = (int) ($resp->header('retry-after') ?? 0);
            $wait = $retryAfter > 0 ? min($retryAfter + 1, 65) : 62;
            $this->log("  rate-limited (429); waiting {$wait}s for the throttle window to reset…");
            sleep($wait);
            $resp = $fn();
            $attempts++;
        }
        return $resp;
    }
}
