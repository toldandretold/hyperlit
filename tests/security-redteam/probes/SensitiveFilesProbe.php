<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Tries to fetch files that should never be web-reachable: env files, the git
 * directory, logs, dumps, debug artifacts left in the repo root, and common
 * dev-tooling routes (Telescope/Horizon/phpinfo). On a misconfigured web root
 * (doc-root pointing at the project instead of public/) these are a one-request
 * full compromise.
 */
class SensitiveFilesProbe extends Probe
{
    public function name(): string
    {
        return 'Sensitive File Exposure';
    }

    public function run(): array
    {
        // path => [needle that proves it's the real file, severity]
        $targets = [
            '/.env'                       => ['APP_KEY', Finding::CRITICAL],
            '/.env.testing'               => ['DB_', Finding::CRITICAL],
            '/.env.example'               => ['APP_NAME', Finding::LOW],
            '/.git/config'                => ['[core]', Finding::CRITICAL],
            '/.git/HEAD'                  => ['ref:', Finding::HIGH],
            '/composer.json'              => ['"require"', Finding::LOW],
            '/composer.lock'              => ['"packages"', Finding::LOW],
            '/package.json'               => ['"dependencies"', Finding::LOW],
            '/storage/logs/laravel.log'   => ['production.ERROR', Finding::HIGH],
            '/dump.rdb'                    => ['REDIS', Finding::MEDIUM],
            '/cookies.txt'                => ['Netscape', Finding::MEDIUM],
            '/epub_normalizer_debug.txt'  => ['', Finding::LOW],
            '/phpinfo.php'                => ['phpinfo()', Finding::HIGH],
            '/telescope/requests'         => ['Telescope', Finding::HIGH],
            '/horizon/api/stats'          => ['"jobsPerMinute"', Finding::HIGH],
            '/.DS_Store'                  => ['Bud1', Finding::LOW],
        ];

        $findings = [];
        foreach ($targets as $path => [$needle, $severity]) {
            $resp = $this->ctx->anon->get($path);
            // A real hit = 2xx AND (no needle required, or the needle appears).
            $served = $resp->ok() && ($needle === '' || str_contains($resp->body, $needle));
            if ($served) {
                $findings[] = $this->vuln(
                    "Reachable: $path",
                    $severity,
                    "The file/route `$path` is served to anonymous visitors (HTTP {$resp->status}).",
                    "GET $path",
                    $resp->snippet(200),
                    "Block this path. Ensure the web root points at `public/` only, and add a deny rule for dotfiles/dumps."
                );
            } else {
                $findings[] = $this->safe("Blocked: $path", "Returned HTTP {$resp->status}; not served.", "GET $path");
            }
        }

        return $findings;
    }
}
