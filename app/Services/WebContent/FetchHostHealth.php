<?php

namespace App\Services\WebContent;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * What we know about whether a host will let us read it — and what we already tried.
 *
 * Two jobs, and the second is the one that compounds.
 *
 * 1. STOP PAYING for hosts that refuse everything. Citation resolution walks plain GET → headless
 *    browser → managed unblocker → unblocker with JS rendering → landing-page PDF hunt. On a host
 *    that refuses all of it that is 201 seconds per URL (measured), and five such hosts were a
 *    large share of a 39-minute, 59-URL run. Without memory, every review re-learns it.
 *
 * 2. BUILD THE RECORD of where effort would pay. `citations_blocked` ranks hosts by how many
 *    references they have actually cost us, and `channels_tried` says whether a host has already
 *    seen everything we own or whether a new technique is untested on it. `citation:hosts` reads
 *    both. Folklore ("we can't read the Economist") becomes a number with evidence attached.
 *
 * Deliberately narrow: only `blocked` and `unreachable` are recorded. A 404 is a fact about a URL,
 * and writing it here would condemn a publisher for one rotted link.
 *
 * Deliberately NOT permanent: the cooldown is a backoff ladder, the same shape as
 * HarvestAttemptRecorder's, because bot walls are frequently rate-based — a host that refuses
 * today may serve next month. Nothing is retired forever.
 *
 * Separate from ProxyPolicy/`fetch_host_policy` on purpose: that answers HOW to route a fetch
 * (direct or proxied) and is a one-way ratchet; this answers WHETHER to bother and expires.
 */
class FetchHostHealth
{
    /**
     * Hours before a host is retried, indexed by consecutive failures. Past the end the last value
     * repeats — long, but never permanent.
     */
    private const BACKOFF_HOURS = [6, 24, 96, 336, 720];

    /** Host-level outcomes. Everything else is about a URL, not a publisher. */
    public const RECORDABLE = [
        WebTextAcquirer::GRADE_BLOCKED,
        WebTextAcquirer::GRADE_UNREACHABLE,
    ];

    /** @var array<string, bool>|null in-request memo; a citation wave asks about the same hosts repeatedly */
    private ?array $memo = null;

    /** Set by ignoreCooldowns(); makes isCoolingOff() always answer false. */
    private bool $ignoring = false;

    /**
     * The host, with a leading `www.` stripped.
     *
     * ProxyPolicy deliberately does not normalise this, because a routing
     * decision is about the exact address asked. Here the opposite is right:
     * the report is about a PUBLISHER, and chacko's corpus cites both
     * `article-14.com` and `www.article-14.com`. Counting those separately
     * halves the apparent cost of a host and hides it in the ranking.
     */
    public static function hostOf(?string $url): ?string
    {
        if (! $url) {
            return null;
        }
        $host = parse_url($url, PHP_URL_HOST);
        if (! $host) {
            return null;
        }

        return preg_replace('/^www\./', '', ltrim(strtolower($host), '.'));
    }

    /**
     * Is this host cooling off? True means skip the whole ladder.
     */
    public function isCoolingOff(?string $host): bool
    {
        if ($host === null || $this->ignoring) {
            return false;
        }

        if ($this->memo === null) {
            $this->memo = [];
        }

        return $this->memo[$host] ??= $this->table()
            ->where('host', $host)
            ->where('retry_after', '>', now())
            ->exists();
    }

    /**
     * The stored verdict for a cooling-off host, so the caller can report WHY it skipped rather
     * than inventing a fresh-looking failure.
     *
     * @return array{outcome: string, reason: ?string, http_status: ?int, retry_after: ?string, consecutive_failures: int}|null
     */
    public function verdict(?string $host): ?array
    {
        if ($host === null) {
            return null;
        }

        $row = $this->table()->where('host', $host)->first();
        if ($row === null) {
            return null;
        }

        return [
            'outcome' => (string) $row->outcome,
            'reason' => $row->reason,
            'http_status' => $row->http_status !== null ? (int) $row->http_status : null,
            'retry_after' => $row->retry_after,
            'consecutive_failures' => (int) $row->consecutive_failures,
        ];
    }

    /**
     * Record a host-level failure and extend its cooldown.
     *
     * @param  list<string>  $channelsTried
     */
    public function recordFailure(
        ?string $host,
        string $outcome,
        ?string $reason,
        ?int $httpStatus,
        array $channelsTried = [],
    ): void {
        if ($host === null || ! in_array($outcome, self::RECORDABLE, true)) {
            return;
        }

        $existing = $this->table()->where('host', $host)->first();
        $failures = (int) ($existing->consecutive_failures ?? 0) + 1;

        // Union the channels: a later attempt may have tried fewer rungs (an early wall short-
        // circuits the ladder), and losing the knowledge that the browser was already spent on
        // this host would make the record useless for deciding what to try next.
        $channels = array_values(array_unique(array_merge(
            $this->decodeChannels($existing->channels_tried ?? null),
            $channelsTried,
        )));

        $row = [
            'outcome' => $outcome,
            'reason' => $reason,
            'http_status' => $httpStatus,
            'channels_tried' => json_encode($channels),
            'consecutive_failures' => $failures,
            'citations_blocked' => (int) ($existing->citations_blocked ?? 0) + 1,
            'retry_after' => $this->retryAfter($failures),
            'last_attempt_at' => now(),
            'updated_at' => now(),
        ];

        if ($existing === null) {
            $this->table()->insert($row + [
                'host' => $host,
                'successes' => 0,
                'first_failed_at' => now(),
                'created_at' => now(),
            ]);
        } else {
            $this->table()->where('host', $host)->update($row);
        }

        $this->memo = null;

        Log::info('FetchHostHealth: host cooling off', [
            'host' => $host, 'outcome' => $outcome, 'failures' => $failures,
            'retry_after' => $row['retry_after']->toIso8601String(),
        ]);
    }

    /**
     * A host let us read something. Clears the cooldown but KEEPS the history — the fact that
     * this publisher cost us four citations last month is exactly the sort of thing worth
     * remembering once it starts working again.
     */
    public function recordSuccess(?string $host): void
    {
        if ($host === null) {
            return;
        }

        $affected = $this->table()->where('host', $host)->update([
            'consecutive_failures' => 0,
            'retry_after' => null,
            'successes' => DB::raw('successes + 1'),
            'last_attempt_at' => now(),
            'updated_at' => now(),
        ]);

        if ($affected > 0) {
            $this->memo = null;
        }
    }

    /**
     * Hosts ranked by what they have cost us. The "where would effort pay" report.
     *
     * @return list<object>
     */
    public function costliest(int $limit = 50): array
    {
        return $this->table()
            ->orderByDesc('citations_blocked')
            ->orderByDesc('consecutive_failures')
            ->limit($limit)
            ->get()
            ->all();
    }

    /**
     * Ignore cooldowns for the rest of this process.
     *
     * The measurement escape hatch: `citation:web:bench` exists to tell us
     * whether a change moved the needle, and a bench that silently skipped
     * every known-bad host would report an improvement that is really just
     * memory. Deliberately per-process and not persisted.
     */
    public function ignoreCooldowns(): void
    {
        $this->ignoring = true;
        $this->memo = null;
    }

    /** Lift a cooldown by hand — after a new technique lands, or for a one-off retry. */
    public function clear(?string $host = null): int
    {
        $query = $this->table();
        if ($host !== null) {
            $query->where('host', $host);
        }
        $this->memo = null;

        return $query->update(['retry_after' => null, 'consecutive_failures' => 0, 'updated_at' => now()]);
    }

    private function retryAfter(int $failures): \Illuminate\Support\Carbon
    {
        $index = min($failures, count(self::BACKOFF_HOURS)) - 1;

        return now()->addHours(self::BACKOFF_HOURS[max(0, $index)]);
    }

    /** @return list<string> */
    private function decodeChannels(mixed $stored): array
    {
        if (is_array($stored)) {
            return array_values(array_filter($stored, 'is_string'));
        }
        if (is_string($stored)) {
            $decoded = json_decode($stored, true);

            return is_array($decoded) ? array_values(array_filter($decoded, 'is_string')) : [];
        }

        return [];
    }

    private function table(): \Illuminate\Database\Query\Builder
    {
        return DB::connection('pgsql_admin')->table('fetch_host_reachability');
    }
}
