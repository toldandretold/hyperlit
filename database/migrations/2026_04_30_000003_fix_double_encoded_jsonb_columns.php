<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

return new class extends Migration
{
    /**
     * Columns to check and repair for double-encoded JSONB data.
     * Each entry: [table, column, expected jsonb_typeof].
     */
    private array $columns = [
        ['hyperlights', 'preview_nodes', 'array'],
        ['footnotes', 'preview_nodes', 'array'],
        ['hypercites', 'raw_json', 'object'],
        ['hyperlights', 'raw_json', 'object'],
        ['hyperlights', 'node_id', 'array'],
        ['hyperlights', 'charData', 'object'],
        ['hypercites', 'node_id', 'array'],
        ['hypercites', 'charData', 'object'],
        ['hypercites', 'citedIN', 'array'],
        ['nodes', 'raw_json', 'object'],
        ['nodes', 'footnotes', 'array'],
        ['library', 'raw_json', 'object'],
    ];

    public function up(): void
    {
        foreach ($this->columns as [$table, $column, $expected]) {
            $this->repairColumn($table, $column, $expected);
        }
    }

    private function repairColumn(string $table, string $column, string $expected): void
    {
        // Count affected rows before repair
        $count = DB::selectOne(
            "SELECT count(*) as cnt FROM {$table} WHERE jsonb_typeof(\"{$column}\") = 'string'"
        )->cnt;

        if ($count === 0) {
            Log::info("JSONB fix: {$table}.{$column} — no double-encoded rows found.");
            return;
        }

        Log::warning("JSONB fix: {$table}.{$column} — found {$count} double-encoded rows. Repairing...");

        // Loop to handle values that may be encoded 2+ levels deep
        $maxPasses = 5;
        $totalFixed = 0;

        for ($pass = 1; $pass <= $maxPasses; $pass++) {
            $affected = DB::update(
                "UPDATE {$table}
                 SET \"{$column}\" = (\"{$column}\" #>> '{}')::jsonb
                 WHERE jsonb_typeof(\"{$column}\") = 'string'"
            );

            $totalFixed += $affected;

            if ($affected === 0) {
                break;
            }

            Log::info("JSONB fix: {$table}.{$column} — pass {$pass} repaired {$affected} rows.");
        }

        Log::info("JSONB fix: {$table}.{$column} — done. Total repaired: {$totalFixed}.");
    }

    public function down(): void
    {
        // No-op — we don't want to re-corrupt data.
    }
};
