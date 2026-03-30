<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Str;

class BillingLedger extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $table = 'billing_ledger';

    const UPDATED_AT = null; // immutable — no updated_at

    protected $fillable = [
        'id',
        'user_id',
        'type',
        'amount',
        'description',
        'category',
        'line_items',
        'metadata',
        'balance_after',
    ];

    protected function casts(): array
    {
        return [
            'amount'        => 'decimal:4',
            'balance_after' => 'decimal:2',
            'line_items'    => 'array',
            'metadata'      => 'array',
        ];
    }

    protected static function boot()
    {
        parent::boot();

        static::creating(function ($entry) {
            if (empty($entry->id)) {
                $entry->id = Str::uuid()->toString();
            }
        });
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
