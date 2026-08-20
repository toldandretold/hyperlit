<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ImportBatch extends Model
{
    protected $table = 'import_batches';
    protected $primaryKey = 'id';
    protected $keyType = 'string';
    public $incrementing = false;

    protected $hidden = ['creator_token'];

    protected $fillable = [
        'id',
        'user_id',
        'creator',
        'creator_token',
        'label',
        'source',
        'shelf_id',
        'notify_email',
        'completed_notified_at',
        'dismissed_at',
    ];

    protected $casts = [
        'notify_email' => 'boolean',
        'completed_notified_at' => 'datetime',
        'dismissed_at' => 'datetime',
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    public function items()
    {
        return $this->hasMany(ImportItem::class, 'batch_id', 'id')->orderBy('position');
    }
}
