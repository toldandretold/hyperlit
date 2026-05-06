<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Shelf extends Model
{
    protected $table = 'shelves';
    protected $primaryKey = 'id';
    protected $keyType = 'string';
    public $incrementing = false;

    protected $hidden = ['creator_token'];

    protected $fillable = [
        'creator',
        'creator_token',
        'name',
        'description',
        'visibility',
        'default_sort',
    ];

    protected $casts = [
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    public function items()
    {
        return $this->hasMany(ShelfItem::class, 'shelf_id', 'id');
    }
}
