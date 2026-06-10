<?php

/**
 * Hyperlit Red-Team Runner
 * ========================
 *
 * A standalone, dependency-free offensive security harness. It treats the site
 * as a black box: it registers its own throwaway accounts against the live
 * target, fires a battery of real attacks (SQLi, IDOR, auth bypass, privilege
 * escalation, path traversal, SSRF, DoS, info disclosure), and writes a
 * timestamped Markdown + JSON report under reports/.
 *
 * This is the "actively try to break in" counterpart to the assertion-based
 * Pest suite in tests/Feature/Security/ (which proves specific defenses hold in
 * isolation). Run this against a running server; run those in CI.
 *
 * USAGE
 *   php tests/security-redteam/run.php [options]
 *
 * OPTIONS
 *   --target=URL     Base URL to attack. Default: http://hyperlit.test
 *   --aggressive     Also run DESTRUCTIVE probes (rate-limit burst, SSRF fetches,
 *                    Stripe checkout, oversized-body DoS). Off by default.
 *   --only=a,b       Run only probes whose name contains one of these substrings
 *                    (case-insensitive), e.g. --only=sql,idor
 *   --list           List available probes and exit.
 *   --verbose        Print every HTTP request to stderr.
 *   --marker=STR     Prefix for the throwaway accounts (default: rt). Keep short
 *                    (<=4) — usernames must be <=30 chars.
 *
 * SAFETY
 *   - Point this at LOCAL / STAGING. Do not attack production or any host you
 *     don't own. It creates real accounts and (in --aggressive) real Stripe
 *     test sessions and outbound fetches.
 *   - Throwaway accounts are named `<marker>_attacker_*` / `<marker>_victim_*`
 *     with @redteam.local emails. See the README for the cleanup snippet.
 *
 * EXIT CODE
 *   0 if no VULNERABLE findings, 1 if any were confirmed (CI-gate friendly).
 */

require __DIR__ . '/src/HttpClient.php';
require __DIR__ . '/src/Finding.php';
require __DIR__ . '/src/Probe.php';
require __DIR__ . '/src/Context.php';
require __DIR__ . '/src/Report.php';

foreach (glob(__DIR__ . '/probes/*.php') as $probeFile) {
    require $probeFile;
}

use RedTeam\Context;
use RedTeam\Report;

// ---- parse args ----
$opts = [
    'target'     => 'http://hyperlit.test',
    'aggressive' => false,
    'only'       => [],
    'list'       => false,
    'verbose'    => false,
    'marker'     => 'rt',
];
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--aggressive') {
        $opts['aggressive'] = true;
    } elseif ($arg === '--list') {
        $opts['list'] = true;
    } elseif ($arg === '--verbose') {
        $opts['verbose'] = true;
    } elseif (str_starts_with($arg, '--target=')) {
        $opts['target'] = substr($arg, 9);
    } elseif (str_starts_with($arg, '--only=')) {
        $opts['only'] = array_filter(array_map('trim', explode(',', strtolower(substr($arg, 7)))));
    } elseif (str_starts_with($arg, '--marker=')) {
        $opts['marker'] = preg_replace('/[^a-z0-9]/i', '', substr($arg, 9)) ?: 'rt';
    } else {
        fwrite(STDERR, "Unknown option: $arg\n");
        exit(2);
    }
}

// The full probe roster (order = report/run order: recon first, heavy last).
$probeClasses = [
    \RedTeam\Probes\InfoDisclosureProbe::class,
    \RedTeam\Probes\SensitiveFilesProbe::class,
    \RedTeam\Probes\CookieSecurityProbe::class,
    \RedTeam\Probes\AuthBypassProbe::class,
    \RedTeam\Probes\UserEnumerationProbe::class,
    \RedTeam\Probes\IdorProbe::class,
    \RedTeam\Probes\ContentIdorProbe::class,
    \RedTeam\Probes\SqlInjectionProbe::class,
    \RedTeam\Probes\PrivilegeEscalationProbe::class,
    \RedTeam\Probes\AdminImpersonationProbe::class,
    \RedTeam\Probes\PathTraversalProbe::class,
    \RedTeam\Probes\WebhookForgeryProbe::class,
    \RedTeam\Probes\RateLimitProbe::class,
    \RedTeam\Probes\OpenRedirectProbe::class,
    \RedTeam\Probes\StoredXssProbe::class,
    \RedTeam\Probes\SsrfProbe::class,
    \RedTeam\Probes\DosProbe::class,
];

$logger = function (string $msg): void {
    fwrite(STDOUT, $msg . "\n");
};

if ($opts['list']) {
    $logger("Available probes:");
    foreach ($probeClasses as $cls) {
        $tmp = new $cls(new Context('http://x', false, 'rt', fn () => null));
        $tag = $tmp->destructive() ? ' [destructive — needs --aggressive]' : '';
        $logger(sprintf("  - %s%s", $tmp->name(), $tag));
    }
    exit(0);
}

$startedAt = date('c');
$logger(str_repeat('=', 64));
$logger(" Hyperlit Red-Team  |  target: {$opts['target']}");
$logger(" mode: " . ($opts['aggressive'] ? 'AGGRESSIVE (destructive ON)' : 'safe (read-only)'));
$logger(str_repeat('=', 64));

$ctx = new Context($opts['target'], $opts['aggressive'], $opts['marker'], $logger);
$ctx->attacker->verbose = $ctx->victim->verbose = $ctx->anon->verbose = $opts['verbose'];

// Reachability check.
$ping = $ctx->anon->get('/');
if ($ping->status === 0) {
    $logger("\n✗ Target unreachable ({$opts['target']}): {$ping->error}");
    $logger("  Is the dev server running? Try --target=http://127.0.0.1:8000");
    exit(2);
}
$logger("→ Target reachable (HTTP {$ping->status}). Provisioning attacker/victim accounts…");
$ctx->bootstrapAccounts();
$logger($ctx->accountsReady
    ? "✓ Accounts ready (attacker" . ($ctx->victimCreds ? " + victim" : "") . ")."
    : "⚠ Could not authenticate accounts — auth-dependent probes will be INCONCLUSIVE.");

$report = new Report($opts['target'], $opts['aggressive'], $startedAt);

foreach ($probeClasses as $cls) {
    /** @var \RedTeam\Probe $probe */
    $probe = new $cls($ctx);
    $name  = $probe->name();

    if ($opts['only'] && !arrayContainsSubstr($opts['only'], strtolower($name))) {
        continue;
    }
    if ($probe->destructive() && !$opts['aggressive']) {
        $logger("\n▷ SKIP (destructive, needs --aggressive): $name");
        continue;
    }

    $logger("\n▶ $name");
    try {
        $findings = $probe->run();
    } catch (\Throwable $e) {
        $logger("  ! probe threw: " . $e->getMessage());
        $findings = [];
    }
    foreach ($findings as $f) {
        $icon = match ($f->status) {
            'VULNERABLE'   => '🔴',
            'SAFE'         => '🟢',
            default        => '⚪',
        };
        $sev = $f->isVulnerable() ? " [{$f->severity}]" : '';
        $logger("  $icon$sev {$f->title}");
    }
    $report->addAll($findings);
}

$paths = $report->write(__DIR__ . '/reports');
$counts = $report->counts();

$logger("\n" . str_repeat('=', 64));
$logger(sprintf(" RESULT: %d vulnerable, %d safe, %d inconclusive",
    $counts['VULNERABLE'], $counts['SAFE'], $counts['INCONCLUSIVE']));
$logger(" Report: {$paths[0]}");
$logger("         {$paths[1]}");
$logger(str_repeat('=', 64));

exit($counts['VULNERABLE'] > 0 ? 1 : 0);

function arrayContainsSubstr(array $needles, string $haystack): bool
{
    foreach ($needles as $n) {
        if ($n !== '' && str_contains($haystack, $n)) {
            return true;
        }
    }
    return false;
}
