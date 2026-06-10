<?php

namespace RedTeam;

/**
 * Base class for an attack module.
 *
 * A probe receives the shared {@see Context} (target URL, attacker/victim
 * sessions, run options, a logger) and returns a list of {@see Finding}s.
 *
 * Contract:
 *   - name()        short human label used in the report and CLI filter.
 *   - destructive() true if the probe writes/deletes data or hammers the server;
 *                   the runner SKIPS these unless --aggressive is passed.
 *   - run()         do the work, return findings.
 *
 * Probes must be idempotent-ish and never throw: wrap risky bits and emit an
 * INCONCLUSIVE finding instead of dying, so one flaky endpoint can't abort the
 * whole run.
 */
abstract class Probe
{
    protected Context $ctx;

    public function __construct(Context $ctx)
    {
        $this->ctx = $ctx;
    }

    abstract public function name(): string;

    /** Override and return true for probes that mutate state or flood the server. */
    public function destructive(): bool
    {
        return false;
    }

    /** @return Finding[] */
    abstract public function run(): array;

    // ---- small helpers shared by concrete probes -------------------------

    protected function vuln(string $title, string $severity, string $detail, string $endpoint = '', string $evidence = '', string $rec = ''): Finding
    {
        return new Finding($this->name(), $title, Finding::VULNERABLE, $severity, $detail, $endpoint, $evidence, $rec);
    }

    protected function safe(string $title, string $detail, string $endpoint = '', string $evidence = ''): Finding
    {
        return new Finding($this->name(), $title, Finding::SAFE, Finding::INFO, $detail, $endpoint, $evidence);
    }

    protected function inconclusive(string $title, string $detail, string $endpoint = ''): Finding
    {
        return new Finding($this->name(), $title, Finding::INCONCLUSIVE, Finding::INFO, $detail, $endpoint);
    }

    protected function log(string $msg): void
    {
        $this->ctx->log('  ' . $msg);
    }
}
