<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ShelfItem extends Model
{
    protected $table = 'shelf_items';
    public $incrementing = false;
    public $timestamps = false;

    protected $fillable = [
        'shelf_id',
        'book',
        'manual_position',
        'added_at',
    ];

    protected $casts = [
        'manual_position' => 'float',
        'added_at' => 'datetime',
    ];

    public function shelf()
    {
        return $this->belongsTo(Shelf::class, 'shelf_id', 'id');
    }
}
