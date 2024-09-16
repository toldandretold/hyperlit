<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddCascadeDeletesToTextMappings extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('text_mappings', function (Blueprint $table) {
            // Drop the old foreign key
            $table->dropForeign(['highlight_id']);

            // Recreate the foreign key with cascade on delete
            $table->foreign('highlight_id')
                  ->references('id')->on('highlights')
                  ->onDelete('cascade');
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('text_mappings', function (Blueprint $table) {
            // Drop the cascade delete foreign key
            $table->dropForeign(['highlight_id']);

            // Recreate the foreign key without cascade
            $table->foreign('highlight_id')
                  ->references('id')->on('highlights');
        });
    }
}
