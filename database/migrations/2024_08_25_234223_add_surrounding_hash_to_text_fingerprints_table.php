<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddSurroundingHashToTextFingerprintsTable extends Migration
{
    public function up()
    {
        Schema::table('text_fingerprints', function (Blueprint $table) {
            $table->string('surrounding_hash')->nullable()->after('hash');
        });
    }

    public function down()
    {
        Schema::table('text_fingerprints', function (Blueprint $table) {
            $table->dropColumn('surrounding_hash');
        });
    }
}
