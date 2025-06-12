<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class MakeFootnotesRawJsonNullable extends Migration
{
    public function up()
    {
        Schema::table('footnotes', function (Blueprint $table) {
            // allow raw_json to be null (and default to NULL)
            $table->json('raw_json')
                  ->nullable()
                  ->default(null)
                  ->change();
        });
    }

    public function down()
    {
        Schema::table('footnotes', function (Blueprint $table) {
            // revert back to NOT NULL with an empty object default
            $table->json('raw_json')
                  ->nullable(false)
                  ->default(json_encode(new \stdClass()))
                  ->change();
        });
    }
}