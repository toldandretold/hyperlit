<?php

namespace App\Support;

/**
 * Request-scoped Server-Timing collector for the page-load performance work.
 * Controllers bracket their expensive sections with start()/stop(); the
 * AddServerTiming middleware emits the standard `Server-Timing` header, which
 * browser devtools show inline on the request and the PHP latency harness
 * (tests/Feature/Api/Concurrency/UserPageLatencyTest.php) can read to
 * attribute its totals.
 *
 * Disabled unless SERVER_TIMING_ENABLED=true (config/app.php server_timing) —
 * off in prod by default: the header names internal phases, and the collector
 * should be zero-cost when nobody is measuring.
 *
 * Resolved as a scoped singleton (fresh per request under Octane too).
 */
class ServerTiming
{
    /** @var array<string, float> label => started-at (hrtime ns) */
    private array $open = [];

    /** @var array<string, float> label => accumulated ms */
    private array $durations = [];

    public function enabled(): bool
    {
        return (bool) config('app.server_timing');
    }

    public function start(string $label): void
    {
        if (!$this->enabled()) {
            return;
        }
        $this->open[$label] = hrtime(true);
    }

    public function stop(string $label): void
    {
        if (!isset($this->open[$label])) {
            return;
        }
        $ms = (hrtime(true) - $this->open[$label]) / 1e6;
        unset($this->open[$label]);
        $this->durations[$label] = ($this->durations[$label] ?? 0.0) + $ms;
    }

    /** Time a closure under a label and pass its return through. */
    public function span(string $label, callable $work): mixed
    {
        $this->start($label);
        try {
            return $work();
        } finally {
            $this->stop($label);
        }
    }

    /** The `Server-Timing` header value, or null when disabled/empty. */
    public function header(): ?string
    {
        if (!$this->enabled() || $this->durations === []) {
            return null;
        }
        $parts = [];
        foreach ($this->durations as $label => $ms) {
            $parts[] = sprintf('%s;dur=%.1f', $label, $ms);
        }

        return implode(', ', $parts);
    }
}
