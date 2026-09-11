<?php

namespace App\Services\SourceHarvest;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * "Does this publisher need the residential proxy?" — asked per HOST, answered once, remembered.
 *
 * A residential pool sells IP REPUTATION, and reputation is a property of the host we are asking,
 * not of us. Most of the diamond corpus (OJS installs, institutional repositories) walls nobody, so
 * paying metered residential GB to reach it buys literally nothing; a handful of commercial
 * publishers behind Cloudflare or AWS WAF are the entire reason the pool exists. Treating that as
 * one global switch overpaid on the many and, when the vendor returned 402 on 2026-09-11, took the
 * whole pipeline down with it.
 *
 * ## The ratchet
 *
 * `direct` → `proxy` on any wall evidence, at any time. Never automatically back. This is the
 * single most important property here and it is not conservatism for its own sake: Bristol's AWS
 * WAF is RATE-based — it serves cleanly and begins challenging partway through a batch — so a
 * policy that could revert on a later clean response would oscillate forever, and every swing back
 * to `direct` spends another datacenter-IP probe on a host already known to wall us. Only a human
 * (`set()`) may move a host back.
 *
 * ## Why unknown hosts default to `direct`
 *
 * The two mistakes are not symmetrical. Probing direct at a walled host costs ONE refused request
 * and is then corrected forever. Defaulting to proxy at an open host costs metered GB on every
 * work forever, and nothing would ever discover the error, because we would never try direct again.
 * A silent permanent cost beats a loud one-off, so the one-off wins.
 *
 * That probe is still not free — a refused request teaches Cloudflare this droplet scrapes, and
 * that is effectively permanent across the datacenter range — which is exactly why
 * `harvest:seed-proxy-policy` exists: the corpus we actually harvest should already be known
 * `direct` before it is ever asked.
 */
class ProxyPolicy
{
    public const MODE_DIRECT = 'direct';
    public const MODE_PROXY = 'proxy';

    /** Where a decision came from, for the operator reading the table. */
    public const SOURCE_SEEDED = 'seeded_diamond';
    public const SOURCE_LEARNED = 'learned_wall';
    public const SOURCE_MANUAL = 'manual';

    /** Decisions are read once per work and many times per fetch; this keeps it to one query. */
    private array $memo = [];

    /** The host a policy decision is about, or null when a URL gives us nothing to key on. */
    public function hostOf(?string $url): ?string
    {
        if (! $url) {
            return null;
        }

        $host = parse_url($url, PHP_URL_HOST);

        return $host ? Str::lower(ltrim((string) $host, '.')) : null;
    }

    /**
     * Should this host be reached through the proxy?
     *
     * An unknown host answers `direct` WITHOUT recording anything — a policy row means "we have
     * learned something", and writing one for every host we happen to glance at would bury the few
     * that matter under thousands that never had an opinion attached to them.
     */
    public function useProxyFor(?string $host): bool
    {
        return $host !== null && $this->modeFor($host) === self::MODE_PROXY;
    }

    public function modeFor(?string $host): string
    {
        if ($host === null) {
            return self::MODE_DIRECT;
        }
        if (array_key_exists($host, $this->memo)) {
            return $this->memo[$host];
        }

        $mode = DB::connection('pgsql_admin')->table('fetch_host_policy')
            ->where('host', $host)
            ->value('mode');

        return $this->memo[$host] = ($mode === self::MODE_PROXY ? self::MODE_PROXY : self::MODE_DIRECT);
    }

    /**
     * This host walled us while we were going direct. Ratchet it to `proxy`, permanently.
     *
     * Counts as well as flips: `wall_hits` on a host already marked `proxy` is how you tell "walled
     * us once in March" from "walls us constantly", which is the difference between a publisher
     * worth retrying and one worth dropping from the corpus.
     */
    public function markWalled(string $host, ?string $evidence = null): void
    {
        $db = DB::connection('pgsql_admin');
        $existing = $db->table('fetch_host_policy')->where('host', $host)->first();

        if ($existing === null) {
            $db->table('fetch_host_policy')->insert([
                'host'        => $host,
                'mode'        => self::MODE_PROXY,
                'evidence'    => $evidence === null ? null : Str::limit($evidence, 500),
                'source'      => self::SOURCE_LEARNED,
                'wall_hits'   => 1,
                'decided_at'  => now(),
                'created_at'  => now(),
                'updated_at'  => now(),
            ]);
            Log::info('ProxyPolicy: host ratcheted to proxy', ['host' => $host, 'evidence' => $evidence]);

            return;
        }

        // A manual `direct` is a person overruling us and is NOT overwritten — but the hit is still
        // counted, so the override is visibly costing something rather than silently failing.
        $keepsDirect = $existing->mode === self::MODE_DIRECT && $existing->source === self::SOURCE_MANUAL;

        $db->table('fetch_host_policy')->where('host', $host)->update([
            'mode'       => $keepsDirect ? self::MODE_DIRECT : self::MODE_PROXY,
            'evidence'   => $evidence === null ? $existing->evidence : Str::limit($evidence, 500),
            'source'     => $keepsDirect ? $existing->source : self::SOURCE_LEARNED,
            'wall_hits'  => (int) $existing->wall_hits + 1,
            'decided_at' => $keepsDirect ? $existing->decided_at : now(),
            'updated_at' => now(),
        ]);

        unset($this->memo[$host]);
    }

    /**
     * A direct fetch worked. Records the evidence WITHOUT ever changing a `proxy` verdict.
     *
     * A walled host answering one request cleanly is the normal behaviour of a rate-based WAF, not
     * a reason to go back — see the ratchet note on the class. So this only ever counts.
     */
    public function markDirectOk(string $host): void
    {
        $db = DB::connection('pgsql_admin');

        if ($db->table('fetch_host_policy')->where('host', $host)->exists()) {
            $db->table('fetch_host_policy')->where('host', $host)
                ->update(['direct_successes' => DB::raw('direct_successes + 1'), 'updated_at' => now()]);

            return;
        }

        $db->table('fetch_host_policy')->insert([
            'host'             => $host,
            'mode'             => self::MODE_DIRECT,
            'evidence'         => 'direct fetch succeeded',
            'source'           => self::SOURCE_LEARNED,
            'direct_successes' => 1,
            'decided_at'       => now(),
            'created_at'       => now(),
            'updated_at'       => now(),
        ]);

        $this->memo[$host] = self::MODE_DIRECT;
    }

    /**
     * Seed a host without asking it anything — the whole point being that a probe is not free.
     *
     * Never overwrites an existing row: a learned `proxy` is evidence from a real refusal, and a
     * seeding sweep that ran later must not erase it just because the journal is diamond. Diamond
     * says "no APC", not "no bot wall".
     */
    public function seedDirect(string $host, string $evidence): bool
    {
        $db = DB::connection('pgsql_admin');
        if ($db->table('fetch_host_policy')->where('host', $host)->exists()) {
            return false;
        }

        $db->table('fetch_host_policy')->insert([
            'host'       => $host,
            'mode'       => self::MODE_DIRECT,
            'evidence'   => Str::limit($evidence, 500),
            'source'     => self::SOURCE_SEEDED,
            'decided_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->memo[$host] = self::MODE_DIRECT;

        return true;
    }

    /** The operator's override — the only way a host moves back to `direct`. */
    public function set(string $host, string $mode, ?string $evidence = null): void
    {
        $mode = $mode === self::MODE_PROXY ? self::MODE_PROXY : self::MODE_DIRECT;

        DB::connection('pgsql_admin')->table('fetch_host_policy')->updateOrInsert(
            ['host' => $host],
            [
                'mode'       => $mode,
                'evidence'   => $evidence === null ? null : Str::limit($evidence, 500),
                'source'     => self::SOURCE_MANUAL,
                'decided_at' => now(),
                'updated_at' => now(),
            ],
        );

        unset($this->memo[$host]);
    }

    /** Drop the per-instance memo — for a long-lived worker that must see another process's writes. */
    public function forgetMemo(): void
    {
        $this->memo = [];
    }
}
