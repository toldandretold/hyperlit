<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UpdateHighlightsTableStructure extends Migration
{
    public function up()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Rename columns if they exist
            if (Schema::hasColumn('highlights', 'highlight_text')) {
                $table->renameColumn('highlight_text', 'text');
            }
            if (Schema::hasColumn('highlights', 'hash')) {
                $table->renameColumn('hash', 'highlight_id');
            }

            // Add new columns if they don't exist
            if (!Schema::hasColumn('highlights', 'book')) {
                $table->string('book')->after('text');
            }
            if (!Schema::hasColumn('highlights', 'numerical')) {
                $table->integer('numerical')->after('book');
            }

            // Ensure timestamps exist (Laravel automatically handles this but adding check)
            if (!Schema::hasColumn('highlights', 'created_at')) {
                $table->timestamp('created_at')->nullable();
            }
            if (!Schema::hasColumn('highlights', 'updated_at')) {
                $table->timestamp('updated_at')->nullable();
            }
        });
    }

    public function down()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Reverse the renaming of columns if they exist
            if (Schema::hasColumn('highlights', 'text')) {
                $table->renameColumn('text', 'highlight_text');
            }
            if (Schema::hasColumn('highlights', 'highlight_id')) {
                $table->renameColumn('highlight_id', 'hash');
            }

            // Drop the new columns if they were added
            if (Schema::hasColumn('highlights', 'book')) {
                $table->dropColumn('book');
            }
            if (Schema::hasColumn('highlights', 'numerical')) {
                $table->dropColumn('numerical');
            }

            // Optionally drop timestamps if they weren't in the original table
            if (Schema::hasColumn('highlights', 'created_at')) {
                $table->dropColumn('created_at');
            }
            if (Schema::hasColumn('highlights', 'updated_at')) {
                $table->dropColumn('updated_at');
            }
        });
    }
}
