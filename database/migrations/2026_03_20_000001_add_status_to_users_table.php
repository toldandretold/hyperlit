<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    protected $connection = 'pgsql_admin';

    public function up(): void
    {
        Schema::connection($this->connection)->table('users', function (Blueprint $table) {
            $table->string('status', 50)->nullable()->default(null);
        });
    }

    public function down(): void
    {
        Schema::connection($this->connection)->table('users', function (Blueprint $table) {
            $table->dropColumn('status');
        });
    }
};
