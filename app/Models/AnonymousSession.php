<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AnonymousSession extends Model
{
    protected $fillable = [
        'token',
        'ip_address',
        'user_agent',
        'last_used_at',
        'ip_change_count',      // 🔒 SECURITY: Track IP changes for theft detection
        'last_ip_change_at'     // 🔒 SECURITY: When IP last changed
    ];

    protected $casts = [
        'token' => 'string',
        'created_at' => 'datetime',
        'last_used_at' => 'datetime',
        'last_ip_change_at' => 'datetime',
        'ip_change_count' => 'integer',
    ];

    const UPDATED_AT = null;

    // Override to ensure token is always treated as string
    public function setTokenAttribute($value)
    {
        $this->attributes['token'] = (string) $value;
    }
}