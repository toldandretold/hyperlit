<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

class Vibe extends Model
{
    protected $table = 'vibes';

    protected $keyType = 'string';
    public $incrementing = false;

    protected $fillable = [
        'name',
        'prompt',
        'css_overrides',
        'visibility',
        'creator',
        'creator_token',
        'source_creator',
    ];

    protected $hidden = [
        'creator_token',
    ];

    protected function casts(): array
    {
        return [
            'css_overrides' => 'array',
        ];
    }

    protected static function boot()
    {
        parent::boot();

        static::creating(function ($vibe) {
            if (empty($vibe->id)) {
                $vibe->id = Str::uuid()->toString();
            }
        });
    }
}
