<?php

namespace RedTeam;

/**
 * One observation from a probe.
 *
 * `status` is the load-bearing field:
 *   - VULNERABLE   the attack worked — the defense is absent or broken.
 *   - SAFE         the attack was correctly rejected — recorded as positive evidence.
 *   - INCONCLUSIVE the probe couldn't reach a verdict (endpoint missing, target
 *                  unreachable, ambiguous response) — needs a human eye.
 *
 * We record SAFE results on purpose: a pen-test report that only lists holes
 * tells you nothing about coverage. Seeing "tried X, correctly blocked" is how
 * you trust the suite actually exercised the defense.
 */
class Finding
{
    public const VULNERABLE   = 'VULNERABLE';
    public const SAFE         = 'SAFE';
    public const INCONCLUSIVE = 'INCONCLUSIVE';

    public const CRITICAL = 'Critical';
    public const HIGH     = 'High';
    public const MEDIUM   = 'Medium';
    public const LOW      = 'Low';
    public const INFO     = 'Info';

    public function __construct(
        public string $probe,        // which probe produced this (e.g. "SQL Injection")
        public string $title,        // one-line summary of the specific check
        public string $status,       // VULNERABLE | SAFE | INCONCLUSIVE
        public string $severity,     // Critical | High | Medium | Low | Info
        public string $detail,       // what happened, in prose
        public string $endpoint = '',     // method + path probed
        public string $evidence = '',     // the smoking gun (response snippet, leaked field, timing)
        public string $recommendation = '', // how to fix, if vulnerable
    ) {
    }

    public function isVulnerable(): bool
    {
        return $this->status === self::VULNERABLE;
    }

    public function severityRank(): int
    {
        return match ($this->severity) {
            self::CRITICAL => 0,
            self::HIGH     => 1,
            self::MEDIUM   => 2,
            self::LOW      => 3,
            default        => 4,
        };
    }

    public function toArray(): array
    {
        return [
            'probe'          => $this->probe,
            'title'          => $this->title,
            'status'         => $this->status,
            'severity'       => $this->severity,
            'detail'         => $this->detail,
            'endpoint'       => $this->endpoint,
            'evidence'       => $this->evidence,
            'recommendation' => $this->recommendation,
        ];
    }
}
