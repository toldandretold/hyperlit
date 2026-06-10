<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * The media/asset routes take a `{book}` and `{filename}` straight off the URL
 * and turn them into a filesystem path. If those segments aren't sanitised, a
 * `../../../../etc/passwd` (or the Laravel `.env`) walks out of the storage dir.
 *
 * We send a battery of traversal encodings and look for telltale file contents
 * (root:x:, APP_KEY=) in a 200 response. Read-only.
 */
class PathTraversalProbe extends Probe
{
    public function name(): string
    {
        return 'Path Traversal';
    }

    public function run(): array
    {
        $findings = [];

        $payloads = [
            '../../../../../../etc/passwd',
            '..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
            '....//....//....//etc/passwd',
            '../../../.env',
            '..%2f..%2f..%2f.env',
            '%2e%2e%2f%2e%2e%2f%2e%2e%2f.env',
        ];

        // /{book}/media/{filename}
        foreach ($payloads as $p) {
            $path = '/somebook/media/' . $p;
            $resp = $this->ctx->anon->get($path);
            if ($this->leakedFileContents($resp->body) && $resp->ok()) {
                $findings[] = $this->vuln(
                    'Path traversal in media route',
                    Finding::CRITICAL,
                    "A traversal payload in the media filename returned host file contents (HTTP {$resp->status}).",
                    "GET /{book}/media/{filename}",
                    "payload: $p\n" . $resp->snippet(160),
                    'Reject filenames containing `/`, `..`, or null bytes; resolve realpath() and assert it stays inside the storage dir.'
                );
            }
        }

        // Also poke the {book} segment of the json/download routes.
        foreach (['/%s/nodes.json', '/%s/download-all', '/%s/footnotes.json'] as $tpl) {
            $resp = $this->ctx->anon->get(sprintf($tpl, rawurlencode('../../../.env')));
            if ($this->leakedFileContents($resp->body) && $resp->ok()) {
                $findings[] = $this->vuln(
                    "Path traversal via {book} on $tpl",
                    Finding::CRITICAL,
                    'A traversal payload in the book segment returned host file contents.',
                    "GET $tpl",
                    $resp->snippet(160),
                    'Sanitise the book id to `[A-Za-z0-9_-]` and resolve paths under a fixed base dir.'
                );
            }
        }

        if (!$findings) {
            $findings[] = $this->safe('Traversal payloads rejected', 'All `../` / encoded-traversal payloads on media + book routes returned no host file contents.', 'GET /{book}/media/{filename}');
        }

        return $findings;
    }

    private function leakedFileContents(string $body): bool
    {
        return str_contains($body, 'root:x:0:0')
            || str_contains($body, 'APP_KEY=')
            || preg_match('/DB_PASSWORD=\S/', $body) === 1;
    }
}
