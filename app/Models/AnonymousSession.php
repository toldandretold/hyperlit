<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AnonymousSession extends Model
{
    protected $table = 'anonymous_sessions';
    
    // Disable automatic timestamp management since we only have created_at and last_used_at
    public $timestamps = false;
    
    protected $fillable = [
        'token',
        'last_used_at',
        'ip_address',
        'user_agent',
    ];
    
    protected $casts = [
        'created_at' => 'datetime',
        'last_used_at' => 'datetime',
    ];
}