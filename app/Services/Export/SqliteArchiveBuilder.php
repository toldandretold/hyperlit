<?php

namespace App\Services\Export;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Builds the single-file SQLite data export: library / nodes / hyperlights /
 * hypercites mirrored from Postgres (secret columns denylisted), plus an
 * `embeddings` table storing each node's pgvector as a packed little-endian
 * float32 BLOB — the exact format sqlite-vec ingests, and one line of numpy
 * (`np.frombuffer(blob, dtype=np.float32)`) — and a `manifest` k/v table.
 *
 * Reads run per-book on pgsql_admin (the job resolved visibility already);
 * inserts run in per-book transactions so a whole corpus never sits in
 * memory. Writes to a .work path, atomic-renames on success.
 */
class SqliteArchiveBuilder
{
    /**
     * Columns that must never leave the server, mirroring the strips in the
     * per-book /download-all route: auth/crypto material and server-internal
     * denorm state. `embedding` is excluded from `nodes` because it gets its
     * own properly-typed table; tsvector/sys_period are Postgres-internal.
     */
    private const DENYLIST = [
        'library' => ['creator_token', 'wrapped_dek', 'access_granted'],
        'nodes' => ['embedding', 'search_vector', 'search_vector_simple', 'sys_period', 'raw_json', 'id'],
        'hyperlights' => ['creator_token', 'access_granted', 'id'],
        'hypercites' => ['creator_token', 'access_granted', 'id'],
    ];

    private const EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';

    private const EMBEDDING_DIM = 768;

    /**
     * @param  callable(float):void  $onProgress  fraction 0..1
     * @return string final artifact path
     */
    public function build(ArchiveCorpus $corpus, string $audience, string $workPath, string $finalPath, callable $onProgress): string
    {
        File::ensureDirectoryExists(dirname($workPath), 0755);
        @unlink($workPath);

        $pdo = new \PDO('sqlite:' . $workPath);
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA journal_mode = OFF');
        $pdo->exec('PRAGMA synchronous = OFF');

        $columns = [];
        foreach (array_keys(self::DENYLIST) as $table) {
            $columns[$table] = $this->exportColumns($table);
            $this->createMirrorTable($pdo, $table, $columns[$table]);
        }
        $this->createEmbeddingsTable($pdo);
        $this->writeManifest($pdo, $corpus, $audience);

        $bookIds = $corpus->bookIds();
        $total = max(1, count($bookIds));
        foreach ($bookIds as $i => $book) {
            $pdo->beginTransaction();
            foreach (array_keys(self::DENYLIST) as $table) {
                $this->copyBookRows($pdo, $table, $columns[$table], $book);
            }
            $this->copyEmbeddings($pdo, $book);
            $pdo->commit();
            $onProgress(($i + 1) / $total);
        }

        $pdo = null; // close before rename
        if (!@rename($workPath, $finalPath)) {
            throw new \RuntimeException("Cannot move artifact to {$finalPath}");
        }

        return $finalPath;
    }

    /** @return string[] postgres column names to mirror */
    private function exportColumns(string $table): array
    {
        $all = DB::connection('pgsql_admin')->select(
            "SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ?
               AND is_generated = 'NEVER'
             ORDER BY ordinal_position",
            [$table]
        );

        return array_values(array_diff(
            array_map(fn ($r) => $r->column_name, $all),
            self::DENYLIST[$table]
        ));
    }

    private function createMirrorTable(\PDO $pdo, string $table, array $columns): void
    {
        $defs = implode(', ', array_map(fn ($c) => '"' . $c . '"', $columns));
        $pdo->exec("CREATE TABLE \"{$table}\" ({$defs})");
    }

    private function copyBookRows(\PDO $pdo, string $table, array $columns, string $book): void
    {
        $quoted = array_map(fn ($c) => '"' . $c . '"', $columns);
        $query = DB::connection('pgsql_admin')->table($table)->select($columns);
        // Sub-book rows (footnote books "{book}/…") belong to their parent's export.
        $query->where(fn ($q) => $q->where('book', $book)->orWhere('book', 'LIKE', $book . '/%'));
        if ($table === 'nodes') {
            $query->orderBy('chunk_id')->orderBy('startLine');
        }

        $insert = $pdo->prepare(
            "INSERT INTO \"{$table}\" (" . implode(', ', $quoted) . ') VALUES ('
            . implode(', ', array_fill(0, count($columns), '?')) . ')'
        );

        foreach ($query->cursor() as $row) {
            $values = [];
            foreach ($columns as $c) {
                $v = $row->$c ?? null;
                $values[] = is_bool($v) ? (int) $v : $v;
            }
            $insert->execute($values);
        }
    }

    private function createEmbeddingsTable(\PDO $pdo): void
    {
        $pdo->exec(
            'CREATE TABLE embeddings (
                book TEXT NOT NULL,
                node_id TEXT,
                chunk_id REAL,
                "startLine" REAL,
                model TEXT NOT NULL,
                dim INTEGER NOT NULL,
                embedding BLOB NOT NULL
            )'
        );
    }

    private function copyEmbeddings(\PDO $pdo, string $book): void
    {
        $insert = $pdo->prepare(
            'INSERT INTO embeddings (book, node_id, chunk_id, "startLine", model, dim, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );

        $rows = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $book)
            ->whereNotNull('embedding')
            ->orderBy('chunk_id')->orderBy('startLine')
            ->select(['book', 'node_id', 'chunk_id', 'startLine', DB::raw('embedding::text AS embedding_text')]);

        foreach ($rows->cursor() as $row) {
            $floats = json_decode($row->embedding_text, true);
            if (!is_array($floats) || $floats === []) {
                continue;
            }
            $insert->bindValue(1, $row->book);
            $insert->bindValue(2, $row->node_id);
            $insert->bindValue(3, $row->chunk_id);
            $insert->bindValue(4, $row->startLine);
            $insert->bindValue(5, self::EMBEDDING_MODEL);
            $insert->bindValue(6, count($floats));
            // 'g' = little-endian float32 — sqlite-vec's native vector format.
            $insert->bindValue(7, pack('g*', ...$floats), \PDO::PARAM_LOB);
            $insert->execute();
        }
    }

    private function writeManifest(\PDO $pdo, ArchiveCorpus $corpus, string $audience): void
    {
        $pdo->exec('CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT)');
        $insert = $pdo->prepare('INSERT INTO manifest (key, value) VALUES (?, ?)');

        $skipped = array_map(
            fn ($r) => trim((string) ($r->title ?? '')) ?: $r->book,
            $corpus->encryptedBooks
        );

        foreach ([
            'scope_type' => $corpus->scopeType,
            'scope_id' => $corpus->scopeId,
            'display_name' => $corpus->displayName,
            'page_url' => $corpus->pageUrl,
            'audience' => $audience,
            'generated_at' => now()->toIso8601String(),
            'schema_version' => (string) ArchiveExportStore::SCHEMA_VERSION,
            'book_count' => (string) count($corpus->books),
            'embedding_model' => self::EMBEDDING_MODEL,
            'embedding_dim' => (string) self::EMBEDDING_DIM,
            'embedding_format' => 'little-endian float32 BLOB (numpy: np.frombuffer(blob, dtype=np.float32); sqlite-vec compatible)',
            'e2ee_skipped' => json_encode($skipped),
        ] as $key => $value) {
            $insert->execute([$key, $value]);
        }
    }
}
