<?php

/**
 * ProxyPolicy — "does this publisher need the residential proxy?", asked per host.
 *
 * The behaviour that matters is the RATCHET: a host may move direct → proxy on any wall evidence
 * and never automatically back. Bristol's AWS WAF is rate-based (serves cleanly, then challenges
 * partway through a batch), so a policy that reverted on a later clean response would oscillate,
 * and every swing back to direct spends another datacenter-IP probe on a host already known to
 * wall us.
 */

use App\Services\SourceHarvest\ProxyPolicy;
use Illuminate\Support\Facades\DB;

function ppDb()
{
    return DB::connection('pgsql_admin');
}

function ppCleanup(): void
{
    ppDb()->table('fetch_host_policy')->where('host', 'LIKE', '%.pptest')->delete();
}

beforeEach(fn () => ppCleanup());
afterEach(fn () => ppCleanup());

test('an unknown host goes direct and records nothing', function () {
    $policy = app(ProxyPolicy::class);

    expect($policy->useProxyFor('unseen.pptest'))->toBeFalse();
    // A row means "we have learned something". Writing one for every host we glance at would bury
    // the few that matter under thousands that never had an opinion attached.
    expect(ppDb()->table('fetch_host_policy')->where('host', 'unseen.pptest')->exists())->toBeFalse();
});

test('a wall ratchets the host to proxy, permanently', function () {
    $policy = app(ProxyPolicy::class);

    $policy->markWalled('walled.pptest', 'blocked by an AWS WAF bot check');
    expect($policy->useProxyFor('walled.pptest'))->toBeTrue();

    // A later clean direct response must NOT undo it — that is the rate-based-WAF trap.
    $policy->markDirectOk('walled.pptest');
    expect(app(ProxyPolicy::class)->useProxyFor('walled.pptest'))->toBeTrue();

    $row = ppDb()->table('fetch_host_policy')->where('host', 'walled.pptest')->first();
    expect($row->mode)->toBe(ProxyPolicy::MODE_PROXY);
    expect($row->evidence)->toContain('AWS WAF');
    expect((int) $row->direct_successes)->toBe(1);   // counted, but not acted on
});

test('repeat walls accumulate, which is how a bad publisher becomes visible', function () {
    $policy = app(ProxyPolicy::class);

    $policy->markWalled('repeat.pptest', 'cloudflare');
    $policy->markWalled('repeat.pptest', 'cloudflare');
    $policy->markWalled('repeat.pptest', 'cloudflare');

    expect((int) ppDb()->table('fetch_host_policy')->where('host', 'repeat.pptest')->value('wall_hits'))->toBe(3);
});

test('seeding only ever inserts — it never erases a learned wall', function () {
    $policy = app(ProxyPolicy::class);

    $policy->markWalled('learned.pptest', 'cloudflare');
    // Diamond says "no APC", not "no bot wall", so a later seeding sweep must not overrule evidence
    // from a real refusal.
    expect($policy->seedDirect('learned.pptest', 'diamond-journal host'))->toBeFalse();
    expect(app(ProxyPolicy::class)->useProxyFor('learned.pptest'))->toBeTrue();

    expect($policy->seedDirect('fresh.pptest', 'diamond-journal host, 40 works'))->toBeTrue();
    expect($policy->useProxyFor('fresh.pptest'))->toBeFalse();
});

test('a manual direct override survives later wall hits', function () {
    $policy = app(ProxyPolicy::class);

    $policy->set('override.pptest', ProxyPolicy::MODE_DIRECT, 'operator says this is fine');
    $policy->markWalled('override.pptest', 'cloudflare');

    // The person wins, but the cost of their choice is still counted rather than silently dropped.
    expect(app(ProxyPolicy::class)->useProxyFor('override.pptest'))->toBeFalse();
    expect((int) ppDb()->table('fetch_host_policy')->where('host', 'override.pptest')->value('wall_hits'))->toBe(1);
});

/**
 * The seeding order is the correctness property, and this is the case that proved it: Bristol
 * University Press publishes DIAMOND-OA journals from behind an AWS WAF bot check. A diamond-only
 * seed marked the one host we had the most recorded evidence about as `direct` and would then have
 * probed it from the droplet — the exact request seeding exists to avoid.
 */
test('recorded wall evidence beats the diamond heuristic, whatever order the passes insert in', function () {
    $policy = app(ProxyPolicy::class);

    // Pass 1 (history) has already ratcheted it.
    $policy->markWalled('walled-diamond.pptest', 'seeded from import history: blocked by an AWS WAF bot check');

    // Pass 2 (diamond) must not be able to undo that, because seeding only ever inserts.
    expect($policy->seedDirect('walled-diamond.pptest', 'diamond-journal host, 106 works'))->toBeFalse();
    expect(app(ProxyPolicy::class)->useProxyFor('walled-diamond.pptest'))->toBeTrue();
});

test('hostOf normalises what it is given, and ignores what it cannot key on', function () {
    $policy = app(ProxyPolicy::class);

    expect($policy->hostOf('https://WWW.Triple-C.at/index.php/tripleC/article/view/502'))->toBe('www.triple-c.at');
    expect($policy->hostOf('not a url'))->toBeNull();
    expect($policy->hostOf(null))->toBeNull();
    // A null host is "we have nothing to key on", which must read as direct, never as proxy —
    // otherwise every DOI-only work would silently pay for the pool.
    expect($policy->useProxyFor(null))->toBeFalse();
});
