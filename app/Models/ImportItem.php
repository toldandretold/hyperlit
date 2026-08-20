<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ImportItem extends Model
{
    protected $table = 'import_items';
    protected $primaryKey = 'id';
    protected $keyType = 'string';
    public $incrementing = false;

    /** Item statuses that mean "this import is finished, one way or another". */
    public const TERMINAL_STATUSES = ['upload_failed', 'complete', 'failed'];

    protected $fillable = [
        'id',
        'batch_id',
        'book',
        'title',
        'filename',
        'position',
        'status',
        'error',
    ];

    protected $casts = [
        'position' => 'integer',
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    public function batch()
    {
        return $this->belongsTo(ImportBatch::class, 'batch_id', 'id');
    }
}
