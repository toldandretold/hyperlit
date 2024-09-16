<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UpdateHighlightsTableAddGlobalPosition666 extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Add global_position column
            $table->float('global_position')->nullable()->after('end_position');
            
            // Check if document_index and order_position exist, then drop them
            if (Schema::hasColumn('highlights', 'document_index')) {
                $table->dropColumn('document_index');
            }
            if (Schema::hasColumn('highlights', 'order_position')) {
                $table->dropColumn('order_position');
            }
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Remove global_position column
            $table->dropColumn('global_position');
            
            // Add back the document_index and order_position if necessary
            $table->float('document_index')->nullable();
            $table->integer('order_position')->nullable();
        });
    }
}
