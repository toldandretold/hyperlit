<?php

namespace App\Console\Commands;

use App\Services\SourceHarvest\ProxyPolicy;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Inspect and steer the per-host proxy policy.
 *
 * Seeding exists because a PROBE IS NOT FREE: an unknown host is tried direct once, and if that
 * host turns out to be Cloudflare-walled, the refused request has taught Cloudflare that this
 * droplet scrapes — reputation damage that is effectively permanent and shared across the whole
 * datacenter IP range. For the corpus we actually harvest we already know the answer, so it should
 * be in the table before anything asks.
 *
 * `--seed-diamond` runs TWO passes, and the order is the correctness property:
 *
 *   1. Hosts the import history records as having WALLED us → `proxy`. This is real evidence.
 *   2. Hosts of diamond-journal works → `direct`. This is a heuristic.
 *
 * Diamond is a fact about APCs and says nothing about bot walls, and the two come apart in
 * practice: Bristol University Press publishes diamond-OA journals from behind an AWS WAF bot
 * check. A diamond-only seed therefore marked the single host we have the most recorded evidence
 * about as `direct`, which is the exact probe seeding exists to prevent. Evidence first, heuristic
 * second, and because both passes only ever INSERT, evidence always wins.
 */
class ProxyPolicyCommand extends Command
{
    protected $signature = 'harvest:proxy-policy
                            {--seed-diamond : Seed from history first (hosts that have walled us → proxy), then diamond-journal hosts → direct. Insert-only.}
                            {--set= : Host to set explicitly, e.g. direct.mit.edu}
                            {--mode=proxy : With --set: direct | proxy}
                            {--forget= : Delete a host row so it is probed fresh}
                            {--dry-run : With --seed-diamond, report what would be seeded}';

    protected $description = 'Show or steer which publisher hosts need the residential proxy.';

    public function handle(ProxyPolicy $policy): int
    {
        if ($host = trim((string) $this->option('forget'))) {
            $deleted = DB::connection('pgsql_admin')->table('fetch_host_policy')->where('host', $host)->delete();
            $this->info($deleted ? "Forgot {$host} — it will be probed direct on the next fetch." : "No policy row for {$host}.");

            return 0;
        }

        if ($host = trim((string) $this->option('set'))) {
            $mode = $this->option('mode') === ProxyPolicy::MODE_DIRECT ? ProxyPolicy::MODE_DIRECT : ProxyPolicy::MODE_PROXY;
            $policy->set($host, $mode, 'set by operator');
            $this->info("{$host} → {$mode} (manual). A manual `direct` survives later wall hits; only you can change it back.");

            return 0;
        }

        if ($this->option('seed-diamond')) {
            return $this->seedDiamond($policy);
        }

        return $this->report();
    }

    /**
     * Hosts we have ALREADY watched wall us, straight out of the import history.
     *
     * This pass runs FIRST and it is the one that makes seeding safe. Diamond is a fact about APCs;
     * it says nothing about bot walls, and the two genuinely come apart — Bristol University Press
     * publishes diamond-OA journals from behind an AWS WAF bot check, so a diamond-only seed marks
     * the single host we have the most evidence about as `direct` and then probes it from the
     * droplet. That probe is the thing seeding exists to avoid.
     *
     * `library.pdf_url_status` is where `setPdfUrlStatus` records a refusal, and every reason
     * AccessWallDetector produces begins "blocked by " (see its MARKERS). Matching that prefix
     * rather than naming vendors keeps this correct when a new wall vendor is added there.
     *
     * Because seeding is insert-only, running this before the diamond pass means recorded evidence
     * always beats the heuristic — no ordering subtlety beyond "walls first".
     */
    private function seedKnownWalls(ProxyPolicy $policy, bool $dry): int
    {
        $rows = DB::connection('pgsql_admin')
            ->table('library as l')
            ->join('canonical_source as cs', 'cs.id', '=', 'l.canonical_source_id')
            ->where('l.pdf_url_status', 'ILIKE', 'blocked by %')
            ->select('cs.pdf_url', 'cs.oa_url', 'l.pdf_url_status')
            ->get();

        $walls = [];
        foreach ($rows as $row) {
            foreach ([$row->pdf_url, $row->oa_url] as $url) {
                $host = $policy->hostOf($url);
                if ($host !== null && $host !== 'doi.org' && $host !== 'dx.doi.org') {
                    $walls[$host] ??= ['hits' => 0, 'reason' => $row->pdf_url_status];
                    $walls[$host]['hits']++;
                }
            }
        }
        arsort($walls);

        $seeded = 0;
        foreach ($walls as $host => $info) {
            if ($dry) {
                $this->line(sprintf('  <fg=yellow>would mark proxy</> %-45s (%d recorded wall(s))', $host, $info['hits']));
                continue;
            }
            // seedDirect is insert-only by design; a wall needs the ratchet, which markWalled owns.
            if ($policy->modeFor($host) === ProxyPolicy::MODE_PROXY) {
                continue;
            }
            $policy->markWalled($host, "seeded from import history: {$info['reason']} ({$info['hits']} works)");
            $seeded++;
            $this->line(sprintf('  <fg=yellow>proxy </> %-45s (%d recorded wall(s))', $host, $info['hits']));
        }

        return $dry ? count($walls) : $seeded;
    }

    private function seedDiamond(ProxyPolicy $policy): int
    {
        $dry = (bool) $this->option('dry-run');

        // Evidence before heuristic — see seedKnownWalls.
        $walled = $this->seedKnownWalls($policy, $dry);

        // Hosts come from the works themselves rather than from the registry: `journal_sources`
        // records the journal's identity, not the address its full text is actually served from,
        // and those differ constantly (a journal on one domain whose PDFs live on another).
        $rows = DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->join('journal_sources as js', 'js.id', '=', 'cs.journal_source_id')
            ->where('js.is_diamond', true)
            ->where(function ($q) {
                $q->whereNotNull('cs.pdf_url')->orWhereNotNull('cs.oa_url');
            })
            ->select('cs.pdf_url', 'cs.oa_url')
            ->get();

        $hosts = [];
        foreach ($rows as $row) {
            foreach ([$row->pdf_url, $row->oa_url] as $url) {
                $host = $policy->hostOf($url);
                if ($host !== null && $host !== 'doi.org' && $host !== 'dx.doi.org') {
                    $hosts[$host] = ($hosts[$host] ?? 0) + 1;
                }
            }
        }
        arsort($hosts);

        $seeded = 0;
        foreach ($hosts as $host => $works) {
            if ($dry) {
                $this->line(sprintf('  would seed %-45s (%d works)', $host, $works));
                continue;
            }
            if ($policy->seedDirect($host, "diamond-journal host, {$works} works")) {
                $seeded++;
                $this->line(sprintf('  <fg=green>direct</> %-45s (%d works)', $host, $works));
            }
        }

        $this->newLine();
        $this->info($dry
            ? count($hosts) . " distinct diamond host(s) found, {$walled} with recorded walls — nothing written."
            : "{$walled} marked proxy from recorded walls, {$seeded} newly seeded direct, "
                . (count($hosts) - $seeded) . ' already had a verdict (left alone).');

        return 0;
    }

    private function report(): int
    {
        $rows = DB::connection('pgsql_admin')->table('fetch_host_policy')
            ->orderBy('mode')
            ->orderByDesc('wall_hits')
            ->orderByDesc('direct_successes')
            ->get();

        if ($rows->isEmpty()) {
            $this->warn('No host policy recorded yet — every host will be probed direct once.');
            $this->line('Seed the corpus you already know is open: php artisan harvest:proxy-policy --seed-diamond');

            return 0;
        }

        foreach ($rows as $r) {
            $colour = $r->mode === ProxyPolicy::MODE_PROXY ? 'yellow' : 'green';
            $this->line(sprintf(
                "  <fg={$colour}>%-6s</> %-45s %-16s ok:%-5d walls:%-4d %s",
                $r->mode, $r->host, $r->source, $r->direct_successes, $r->wall_hits,
                $r->evidence ? mb_substr($r->evidence, 0, 60) : '',
            ));
        }

        $this->newLine();
        $proxied = $rows->where('mode', ProxyPolicy::MODE_PROXY)->count();
        $this->info("{$rows->count()} host(s): {$proxied} need the proxy, " . ($rows->count() - $proxied) . ' go direct.');
        if ($proxied === 0) {
            $this->line('Nothing needs the residential pool right now — SOURCE_FETCH_PROXY can stay unset.');
        }

        return 0;
    }
}
