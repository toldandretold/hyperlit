<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::connection('pgsql_admin')->table('library', function (Blueprint $table) {
            $table->text('pdf_url_status')->nullable()->after('pdf_url');
        });
    }

    public function down(): void
    {
        Schema::connection('pgsql_admin')->table('library', function (Blueprint $table) {
            $table->dropColumn('pdf_url_status');
        });
    }
};
