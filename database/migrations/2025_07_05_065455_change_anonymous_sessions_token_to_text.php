<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up()
    {
        Schema::table('anonymous_sessions', function (Blueprint $table) {
            $table->text('token')->change();
        });
    }

    public function down()
    {
        Schema::table('anonymous_sessions', function (Blueprint $table) {
            $table->uuid('token')->change();
        });
    }
};
