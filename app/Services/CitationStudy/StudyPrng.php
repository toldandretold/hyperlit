<?php

namespace App\Services\CitationStudy;

/**
 * Counter-based deterministic PRNG for corpus corruption.
 *
 * sha256("{seed}:{context}:{counter}") drives every draw, so output depends
 * only on (seed, context) — never on processing order, PHP version, or global
 * mt_rand state. That determinism is what lets the paper's methods section say
 * "corruptions are reproducible from the committed spec".
 */
class StudyPrng
{
    private int $counter = 0;

    public function __construct(
        private readonly int $seed,
        private readonly string $context,
    ) {}

    /** Uniform int in [0, $bound) — $bound must be >= 1. */
    public function nextInt(int $bound): int
    {
        if ($bound < 1) {
            throw new \InvalidArgumentException('bound must be >= 1');
        }
        $hash = hash('sha256', "{$this->seed}:{$this->context}:{$this->counter}");
        $this->counter++;
        // 12 hex chars = 48 bits, safely inside PHP int range; modulo bias is
        // negligible at study scale (bounds are tiny vs 2^48).
        return intval(substr($hash, 0, 12), 16) % $bound;
    }

    /** Uniform float in [0, 1). */
    public function nextFloat(): float
    {
        $hash = hash('sha256', "{$this->seed}:{$this->context}:{$this->counter}");
        $this->counter++;
        return intval(substr($hash, 0, 12), 16) / (float) (1 << 48);
    }

    /** Pick one element from a non-empty list. */
    public function pick(array $items): mixed
    {
        if ($items === []) {
            throw new \InvalidArgumentException('cannot pick from an empty list');
        }
        $values = array_values($items);
        return $values[$this->nextInt(count($values))];
    }

    /** Deterministic shuffle (Fisher-Yates driven by this PRNG). */
    public function shuffle(array $items): array
    {
        $values = array_values($items);
        for ($i = count($values) - 1; $i > 0; $i--) {
            $j = $this->nextInt($i + 1);
            [$values[$i], $values[$j]] = [$values[$j], $values[$i]];
        }
        return $values;
    }
}
