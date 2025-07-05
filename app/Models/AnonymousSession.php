<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AnonymousSession extends Model
{
    protected $fillable = [
        'token',
        'ip_address',
        'user_agent', 
        'last_used_at'
    ];

    protected $casts = [
        'token' => 'string',        // Force string casting
        'created_at' => 'datetime',
        'last_used_at' => 'datetime',
    ];

    const UPDATED_AT = null;

    // Override to ensure token is always treated as string
    public function setTokenAttribute($value)
    {
        $this->attributes['token'] = (string) $value;
    }
}