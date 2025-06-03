<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        // Use raw SQL for PostgreSQL to handle the conversion
        DB::statement('ALTER TABLE library ALTER COLUMN timestamp TYPE bigint USING EXTRACT(EPOCH FROM timestamp) * 1000');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        // Convert back from bigint to timestamp
        DB::statement('ALTER TABLE library ALTER COLUMN timestamp TYPE timestamp USING to_timestamp(timestamp / 1000)');
    }
};