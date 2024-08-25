<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UpdateTextFingerprintsTable extends Migration
{
    public function up()
    {
        Schema::table('text_fingerprints', function (Blueprint $table) {
            // Assuming you want to add a foreign key if it wasn't added correctly before
            // Check if the foreign key already exists before adding it.
            // If it already exists, there's no need to do anything in this migration.
            if (!Schema::hasColumn('text_fingerprints', 'source_id')) {
                $table->foreign('source_id')->references('id')->on('highlights')->onDelete('cascade');
            }
        });
    }

    public function down()
    {
        Schema::table('text_fingerprints', function (Blueprint $table) {
            // There's no need to drop the foreign key, as SQLite doesn't support this
        });
    }
}
