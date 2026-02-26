<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->string('sub_book_id')->nullable()->after('book');
            $table->index('sub_book_id');
        });

        Schema::table('footnotes', function (Blueprint $table) {
            $table->string('sub_book_id')->nullable()->after('book');
            $table->index('sub_book_id');
        });

        // Backfill existing data
        DB::statement("
            UPDATE hyperlights SET sub_book_id =
              CASE
                WHEN book NOT LIKE '%/%'
                  THEN book || '/' || hyperlight_id
                ELSE split_part(book, '/', 1) || '/2/' || split_part(book, '/', 2) || '/' || hyperlight_id
              END
            WHERE sub_book_id IS NULL
        ");
        DB::statement('
            UPDATE footnotes SET sub_book_id =
              CASE
                WHEN book NOT LIKE \'%/%\'
                  THEN book || \'/\' || "footnoteId"
                ELSE split_part(book, \'/\', 1) || \'/2/\' || split_part(book, \'/\', 2) || \'/\' || "footnoteId"
              END
            WHERE sub_book_id IS NULL
        ');
    }

    public function down(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('sub_book_id');
        });

        Schema::table('footnotes', function (Blueprint $table) {
            $table->dropColumn('sub_book_id');
        });
    }
};
