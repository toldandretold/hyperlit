<?php

namespace App\Services\Export;

use Illuminate\Support\Facades\File;

/**
 * Filesystem layout + progress bookkeeping for archive export artifacts
 * (markdown vault zips, SQLite data files) built by BuildArchiveExportJob.
 *
 * Artifacts are cached under a digest of the exportable corpus
 * (book + timestamp + annotations_updated_at + visibility per book, plus a
 * schema version), so re-downloads are free until content changes and any
 * exporter change invalidates every cache at once. AUDIENCE is part of the
 * path, derived server-side only — owner artifacts (private books included)
 * are never addressable by a visitor request, which always recomputes
 * audience before touching the filesystem.
 */
class ArchiveExportStore
{
    /** Bump when any builder's output format changes — invalidates all caches. */
    public const SCHEMA_VERSION = 3;

    public const KINDS = ['markdown', 'sqlite'];

    private const EXT = ['markdown' => 'zip', 'sqlite' => 'sqlite'];

    public function digest(ArchiveCorpus $corpus, string $audience, string $kind): string
    {
        return hash('sha256', json_encode([
            self::SCHEMA_VERSION,
            $kind,
            $audience,
            // The display name is baked into the artifact (README title, vault
            // root folder, manifest) — a page rename must refresh the cache.
            $corpus->displayName,
            $corpus->digestRows(),
        ]));
    }

    public function dir(string $scopeType, string $scopeId, string $audience): string
    {
        $safe = $this->safeSegment($scopeId);

        return storage_path("app/archive-exports/{$scopeType}-{$safe}/{$audience}");
    }

    public function artifactPath(string $scopeType, string $scopeId, string $audience, string $kind, string $digest): string
    {
        return $this->dir($scopeType, $scopeId, $audience) . "/{$kind}-{$digest}." . self::EXT[$kind];
    }

    /** The work path a builder writes to before the atomic rename. */
    public function workPath(string $scopeType, string $scopeId, string $audience, string $kind, string $digest): string
    {
        return $this->artifactPath($scopeType, $scopeId, $audience, $kind, $digest) . '.work';
    }

    public function progressPath(string $scopeType, string $scopeId, string $audience, string $kind): string
    {
        return $this->dir($scopeType, $scopeId, $audience) . "/{$kind}-progress.json";
    }

    public function writeProgress(
        string $scopeType,
        string $scopeId,
        string $audience,
        string $kind,
        string $status,
        float $fraction,
        ?string $message = null,
        ?string $filename = null,
        int $bytes = 0,
    ): void {
        $path = $this->progressPath($scopeType, $scopeId, $audience, $kind);
        File::ensureDirectoryExists(dirname($path), 0755);
        File::put($path, json_encode([
            'status' => $status, // building | ready | failed
            'progress' => round(min(1.0, max(0.0, $fraction)), 3),
            'message' => $message,
            'filename' => $filename,
            'bytes' => $bytes,
            'updated_at' => now()->toIso8601String(),
        ]));
    }

    public function readProgress(string $scopeType, string $scopeId, string $audience, string $kind): ?array
    {
        $path = $this->progressPath($scopeType, $scopeId, $audience, $kind);
        if (!is_file($path)) {
            return null;
        }
        $decoded = json_decode((string) File::get($path), true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Older digests are dead the moment a new one exists — the corpus they
     * packaged has changed. Keep at most one artifact per scope/audience/kind.
     */
    public function cleanupStale(string $scopeType, string $scopeId, string $audience, string $kind, string $keepPath): void
    {
        $pattern = $this->dir($scopeType, $scopeId, $audience) . "/{$kind}-*." . self::EXT[$kind];
        foreach (glob($pattern) ?: [] as $old) {
            if ($old !== $keepPath) {
                @unlink($old);
            }
        }
    }

    public static function lockKey(string $scopeType, string $scopeId, string $audience, string $kind): string
    {
        return "archive-export:{$scopeType}:{$scopeId}:{$audience}:{$kind}";
    }

    /**
     * Scope ids can be usernames (spaces, unicode). Filesystem-safe segment;
     * hash suffix keeps distinct ids distinct after sanitization.
     */
    private function safeSegment(string $scopeId): string
    {
        $clean = preg_replace('/[^a-zA-Z0-9_-]+/', '_', $scopeId) ?? '_';

        return $clean . '-' . substr(hash('sha256', $scopeId), 0, 8);
    }
}
