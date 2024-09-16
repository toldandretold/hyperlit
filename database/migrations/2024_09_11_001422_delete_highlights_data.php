<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

class DeleteHighlightsData extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        // Disable foreign key checks
        DB::statement('PRAGMA foreign_keys = OFF;');

        // Truncate the highlights table (delete all rows)
        DB::table('highlights')->truncate();

        // Re-enable foreign key checks
        DB::statement('PRAGMA foreign_keys = ON;');
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        // You don't need to reverse this operation
    }
}
