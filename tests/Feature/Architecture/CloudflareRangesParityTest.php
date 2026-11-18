<?php

/**
 * GATE: "who is Cloudflare" is written in three places and they must agree.
 *
 * hyperlit.io is proxied by Cloudflare, so three things trust Cloudflare's
 * published ranges (https://www.cloudflare.com/ips/) and nothing else:
 *
 *   - bootstrap/app.php            → Laravel trustProxies (per-IP rate limiters)
 *   - deploy/security/nginx/cloudflare-realip.conf → nginx real_ip (logs, PHP REMOTE_ADDR, CrowdSec)
 *   - deploy/security/crowdsec/whitelists.yaml     → CrowdSec never bans the edge
 *
 * A range missing from ONE of them is a silent fault: a request from that edge
 * node is logged / rate-limited / judged by Cloudflare's address instead of the
 * visitor's. Worst case (nginx has it, CrowdSec does not): a scanner routed via
 * that edge gets Cloudflare banned at the firewall and the site goes dark.
 *
 * The droplet's live copies are regenerated from Cloudflare by
 * deploy/security/cloudflare-ips.sh; this test keeps the committed seeds and the
 * PHP list in step with each other. Cloudflare changes its ranges rarely; when
 * it does, update all three from the URL above.
 */
function cidrsIn(string $relativePath, string $pattern): array
{
    $text = (string) file_get_contents(base_path($relativePath));
    preg_match_all($pattern, $text, $m);

    $cidrs = array_map('strtolower', $m[1]);
    sort($cidrs);

    return array_values(array_unique($cidrs));
}

const CIDR = '([0-9a-f.:]+\/[0-9]{1,3})';

it('trusts the same Cloudflare ranges in Laravel, nginx and CrowdSec', function () {
    $laravel = cidrsIn('bootstrap/app.php', '/\'' . CIDR . '\'/i');
    $nginx = cidrsIn('deploy/security/nginx/cloudflare-realip.conf', '/^set_real_ip_from\s+' . CIDR . ';/mi');
    $crowdsec = cidrsIn('deploy/security/crowdsec/whitelists.yaml', '/^\s+-\s+' . CIDR . '\s*$/mi');

    expect($laravel)->not->toBeEmpty('bootstrap/app.php no longer lists Cloudflare CIDRs for trustProxies');
    expect($nginx)->toBe($laravel, 'nginx real-IP snippet and bootstrap/app.php trust different Cloudflare ranges');
    expect($crowdsec)->toBe($laravel, 'CrowdSec whitelist and bootstrap/app.php trust different Cloudflare ranges');
});

it('tells nginx to read the visitor IP from the header only Cloudflare sets', function () {
    $snippet = (string) file_get_contents(base_path('deploy/security/nginx/cloudflare-realip.conf'));

    expect($snippet)->toMatch('/^real_ip_header\s+CF-Connecting-IP;/m');
    // X-Forwarded-For can carry a client-supplied chain; it must not be the source.
    expect($snippet)->not->toMatch('/^real_ip_header\s+X-Forwarded-For/mi');
});
