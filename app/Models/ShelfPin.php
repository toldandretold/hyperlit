<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ShelfPin extends Model
{
    protected $table = 'shelf_pins';
    public $incrementing = false;
    public $timestamps = false;

    protected $hidden = ['creator_token'];

    protected $fillable = [
        'shelf_key',
        'book',
        'position',
        'creator',
        'creator_token',
    ];

    protected $casts = [
        'position' => 'float',
    ];
}
