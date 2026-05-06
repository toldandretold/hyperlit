<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

return new class extends Migration
{
    /**
     * Add slug column to shelves table and backfill existing rows.
     */
    public function up(): void
    {
        $admin = DB::connection('pgsql_admin');

        // Add nullable slug column
        $admin->statement("ALTER TABLE shelves ADD COLUMN slug varchar(255) NULL");

        // Backfill existing rows: generate slug from name, deduplicating per creator
        $shelves = $admin->table('shelves')->get(['id', 'creator', 'name']);

        // Group by creator to handle deduplication scoped per user
        $grouped = $shelves->groupBy('creator');

        foreach ($grouped as $creator => $creatorShelves) {
            $usedSlugs = [];
            foreach ($creatorShelves as $shelf) {
                $baseSlug = Str::slug($shelf->name);
                if ($baseSlug === '') {
                    $baseSlug = 'shelf';
                }
                $slug = $baseSlug;
                $counter = 2;
                while (in_array($slug, $usedSlugs, true)) {
                    $slug = $baseSlug . '-' . $counter;
                    $counter++;
                }
                $usedSlugs[] = $slug;
                $admin->table('shelves')->where('id', $shelf->id)->update(['slug' => $slug]);
            }
        }

        // Now make slug NOT NULL and add unique index
        $admin->statement("ALTER TABLE shelves ALTER COLUMN slug SET NOT NULL");
        $admin->statement("CREATE UNIQUE INDEX shelves_creator_slug_unique ON shelves (creator, slug)");
    }

    /**
     * Reverse the migration.
     */
    public function down(): void
    {
        $admin = DB::connection('pgsql_admin');
        $admin->statement("DROP INDEX IF EXISTS shelves_creator_slug_unique");
        $admin->statement("ALTER TABLE shelves DROP COLUMN IF EXISTS slug");
    }
};
