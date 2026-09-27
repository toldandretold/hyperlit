<?php

namespace App\Services\CitationPipeline\Testing;

use RuntimeException;

/**
 * Record/replay for the resolution ladder's outbound calls, so the ladder's DECISIONS can be
 * characterised and diffed.
 *
 * WHY THIS EXISTS. `CitationScanBibliographyJob::handle()` is 1,596 lines and has no execution
 * coverage at all — every test that names the job reaches past `handle()` into a private helper by
 * reflection, or reads the source file as a string. Its failure mode is silent and expensive: a
 * citation resolves to a DIFFERENT source, the review then verifies a claim against the wrong work,
 * and nothing goes red. That is exactly the hamiltonfinancialplanning.com swap (see
 * CitedUrlOutranksTitleSearchTest), which sat undetected for months. Refactoring the wave ladder
 * without a characterisation golden would be doing that on purpose.
 *
 * WHY A CASSETTE AND NOT A RE-RUN. The ladder queries OpenAlex, Open Library, Semantic Scholar and
 * Brave. Those indexes change under us, so a golden diffed across two live runs reports THEIR drift,
 * not ours — the diff would be noise and would be learned to be ignored, which is worse than no
 * golden. Replay makes the ladder a pure function of its input.
 *
 * WHY PER-KEY AND NOT PER-CALL. The batch methods take and return maps keyed by referenceId
 * (`WorksApi::searchBatch` — "Keyed by referenceId: ['ref1' => 'search title']" in, "candidates keyed
 * by referenceId" out). Storing one entry per KEY rather than per BATCH means the recording survives
 * the refactor re-batching the waves, which it certainly will — splitting one wave's batch in two, or
 * merging two, still hits every entry. A per-call cassette would miss on the first such change and
 * the golden would be useless precisely when it is needed.
 *
 * WHAT IS *NOT* RECORDED. Only the 13 network-touching methods need it. `titleSimilarity`,
 * `metadataScore`, `isCitableWork`, `extractTitle`, `extractDoi` and `extractUrl` are pure local
 * computation and stay live — recording them would freeze the very scoring logic a refactor most
 * needs to be checked against.
 */
class LadderCassette
{
    public const MODE_RECORD = 'record';
    public const MODE_REPLAY = 'replay';

    public const VERSION = 1;

    /** @var array<string, mixed> cassette key => recorded return value */
    private array $entries = [];

    /** @var list<array{method: string, key: string}> replay lookups with no recording */
    private array $misses = [];

    /** @var list<array{method: string, key: string}> absences that are BY DESIGN, with a live fallback */
    private array $fallthroughs = [];

    private int $hits = 0;
    private int $writes = 0;

    /**
     * @param bool $strict In replay, a miss on a SCALAR call always throws — there is no safe
     *                     empty value to invent, and inventing one would turn a changed question
     *                     into a passing golden. A miss on a PER-KEY batch lookup omits the key
     *                     (its natural "no result" shape) and is reported, unless strict.
     */
    public function __construct(
        public readonly string $mode,
        public readonly bool $strict = true,
    ) {
    }

    public static function recording(): self
    {
        return new self(self::MODE_RECORD);
    }

    public static function replaying(string $path, bool $strict = true): self
    {
        if (!is_file($path)) {
            throw new RuntimeException("No cassette at {$path} — record one first with --record.");
        }

        $raw = json_decode((string) file_get_contents($path), true);
        if (!is_array($raw) || ($raw['version'] ?? null) !== self::VERSION) {
            throw new RuntimeException("Cassette at {$path} is not a version " . self::VERSION . ' cassette.');
        }

        $cassette = new self(self::MODE_REPLAY, $strict);
        $cassette->entries = $raw['entries'] ?? [];

        return $cassette;
    }

    public function save(string $path): void
    {
        if (!is_dir(dirname($path))) {
            mkdir(dirname($path), 0775, true);
        }

        // Sorted so a re-record produces a reviewable diff rather than a reshuffle.
        $entries = $this->entries;
        ksort($entries);

        file_put_contents($path, json_encode([
            'version' => self::VERSION,
            'entries' => $entries,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
    }

    // ── The two seams ────────────────────────────────────────────────────────

    /**
     * A whole-call seam, for the methods that are not keyed batches.
     *
     * @template T
     * @param callable(): T $real
     * @return T
     */
    public function through(string $method, array $args, callable $real): mixed
    {
        $key = self::keyFor($method, $args);

        if ($this->mode === self::MODE_REPLAY) {
            if (!array_key_exists($key, $this->entries)) {
                $this->misses[] = ['method' => $method, 'key' => $key];

                throw new RuntimeException(
                    "Cassette miss on {$method} — the ladder asked something it did not ask when the "
                    . 'cassette was recorded. That is a real change in behaviour, not a harness fault: '
                    . 'either the refactor altered what this wave sends, or a wave now runs that did '
                    . 'not before. Re-record only once you have decided the new question is correct.'
                );
            }

            $this->hits++;

            return $this->entries[$key];
        }

        $result = $real();

        if ($this->mode === self::MODE_RECORD) {
            $this->entries[$key] = $result;
            $this->writes++;
        }

        return $result;
    }

    /**
     * Store a result without wrapping the call, for a caller that must INSPECT the result before
     * deciding whether it is cacheable at all (a `pdf_staged` acquire is a receipt for a file
     * write, not a value — see CassetteWebTextAcquirer).
     */
    public function remember(string $method, array $args, mixed $value): void
    {
        if ($this->mode !== self::MODE_RECORD) {
            return;
        }

        $this->entries[self::keyFor($method, $args)] = $value;
        $this->writes++;
    }

    /**
     * A replay lookup that NEVER throws — for call sites inside an async promise chain.
     *
     * `through()` signals a miss by throwing, which is right for a synchronous seam and wrong
     * inside Guzzle's pipeline: `PendingRequest`'s `->otherwise()` handler is typed
     * `OutOfBoundsException|TransferException`, so any other exception raised in a pooled request
     * becomes a TypeError about an argument, and the actual message — which wave asked what — is
     * destroyed. The HTTP replayer uses this instead and lets the COMMAND fail on misses > 0.
     *
     * @return array{hit: bool, value: mixed}
     */
    /**
     * @param bool $countAsMiss Pass false where a gap is EXPECTED and the caller has a correct
     *                          fallback — the side-effecting acquire grades are deliberately never
     *                          stored, so counting their absence as a miss would report a designed
     *                          path as a harness failure and bury the real misses among them.
     */
    public function lookup(string $method, array $args, ?string $label = null, bool $countAsMiss = true): array
    {
        $key = self::keyFor($method, $args);

        if (array_key_exists($key, $this->entries)) {
            $this->hits++;

            return ['hit' => true, 'value' => $this->entries[$key]];
        }

        // Report the READABLE form when the caller has one. A miss is a question the ladder asked
        // and did not ask before; "http:69041a53…" names none of that, and the whole reason to
        // surface a miss is to be able to look at what changed.
        if ($countAsMiss) {
            $this->misses[] = ['method' => $method, 'key' => $label ?? $key];
        } else {
            $this->fallthroughs[] = ['method' => $method, 'key' => $label ?? $key];
        }

        return ['hit' => false, 'value' => null];
    }

    /**
     * The per-key batch seam: one cassette entry per referenceId, so re-batching does not miss.
     *
     * @param array<string, mixed>      $keyed     the keyed argument (refId => query)
     * @param array<string, mixed>      $perKey    extra args that vary BY key (refId => year filter)
     * @param array<string, mixed>      $shared    extra args shared by the whole call (limit, …)
     * @param callable(array): array    $real      runs the real batch over the keys still needed
     * @return array<string, mixed>                results keyed by referenceId
     */
    public function throughBatch(
        string $method,
        array $keyed,
        array $perKey,
        array $shared,
        callable $real,
    ): array {
        $keyFor = fn (string $k): string => self::keyFor($method, [
            'arg'    => $keyed[$k] ?? null,
            'perKey' => $perKey[$k] ?? null,
            'shared' => $shared,
        ]);

        if ($this->mode === self::MODE_REPLAY) {
            $out = [];
            foreach (array_keys($keyed) as $k) {
                $entryKey = $keyFor($k);
                if (array_key_exists($entryKey, $this->entries)) {
                    $this->hits++;
                    // A recorded "this key found nothing" is stored as null and must stay ABSENT
                    // from the result map — that is what the live batch returns for a no-hit key,
                    // and a present-but-null entry reads as a candidate to the scoring code.
                    if ($this->entries[$entryKey] !== null) {
                        $out[$k] = $this->entries[$entryKey];
                    }
                    continue;
                }

                $this->misses[] = ['method' => $method, 'key' => (string) $k];

                if ($this->strict) {
                    throw new RuntimeException(
                        "Cassette miss on {$method} for key '{$k}' — the ladder asked about a "
                        . 'reference, or asked it a different question, than when the cassette was '
                        . 'recorded. Run with --lenient to see the full list before deciding.'
                    );
                }
            }

            return $out;
        }

        $result = $real($keyed);

        if ($this->mode === self::MODE_RECORD) {
            foreach (array_keys($keyed) as $k) {
                // null records the no-hit case explicitly, so replay can tell "asked, found nothing"
                // apart from "never asked" — the same distinction the trace ledger exists to make.
                $this->entries[$keyFor($k)] = $result[$k] ?? null;
                $this->writes++;
            }
        }

        return $result;
    }

    // ── Keying ───────────────────────────────────────────────────────────────

    /**
     * Canonical, order-insensitive for associative arrays. Lists keep their order because for a
     * list argument the order can be meaningful; maps are sorted because the batch APIs are
     * explicitly keyed and a re-batch legitimately reorders them.
     */
    public static function keyFor(string $method, array $args): string
    {
        return $method . ':' . substr(hash('sha256', self::canonical($args)), 0, 32);
    }

    private static function canonical(mixed $value): string
    {
        if (is_array($value)) {
            $isList = array_is_list($value);
            if (!$isList) {
                ksort($value);
            }
            $parts = [];
            foreach ($value as $k => $v) {
                $parts[] = ($isList ? '' : $k . '=') . self::canonical($v);
            }

            return ($isList ? '[' : '{') . implode(',', $parts) . ($isList ? ']' : '}');
        }

        if (is_object($value)) {
            return self::canonical((array) $value);
        }

        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        return $value === null ? 'null' : (string) $value;
    }

    // ── Reporting ────────────────────────────────────────────────────────────

    /** @return list<array{method: string, key: string}> */
    public function misses(): array
    {
        return $this->misses;
    }

    /** @return list<array{method: string, key: string}> */
    public function fallthroughs(): array
    {
        return $this->fallthroughs;
    }

    /** @return array{mode: string, entries: int, hits: int, writes: int, misses: int, fallthroughs: int} */
    public function stats(): array
    {
        return [
            'mode'         => $this->mode,
            'entries'      => count($this->entries),
            'hits'         => $this->hits,
            'writes'       => $this->writes,
            'misses'       => count($this->misses),
            'fallthroughs' => count($this->fallthroughs),
        ];
    }
}
