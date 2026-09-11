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
 * `--seed-diamond` derives hosts from the works of DIAMOND journals. Diamond is a fact about APCs,
 * not about bot walls, so it is a heuristic and not a guarantee — which is exactly why seeding only
 * ever INSERTS. A host that has since walled us keeps its learned `proxy` verdict.
 */
class ProxyPolicyCommand extends Command
{
    protected $signature = 'harvest:proxy-policy
                            {--seed-diamond : Mark the publisher hosts of diamond-journal works as direct (insert-only)}
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

    private function seedDiamond(ProxyPolicy $policy): int
    {
        $dry = (bool) $this->option('dry-run');

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
            ? count($hosts) . ' distinct host(s) found — nothing written.'
            : "{$seeded} newly seeded, " . (count($hosts) - $seeded) . ' already had a verdict (left alone).');

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
