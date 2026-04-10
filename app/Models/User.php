<?php

namespace App\Models;

use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable implements MustVerifyEmail
{
    use HasFactory, Notifiable;

    /**
     * Boot method to auto-generate user_token UUID on creation.
     */
    protected static function boot()
    {
        parent::boot();

        static::creating(function ($user) {
            if (empty($user->user_token)) {
                $user->user_token = Str::uuid()->toString();
            }
        });
    }

    /**
     * Find a user by name using RLS bypass function.
     * Returns only public profile data (id, name, created_at).
     * Used for user profile pages where we need to look up other users.
     */
    public static function findByNamePublic(string $name): ?self
    {
        $result = DB::selectOne('SELECT * FROM lookup_user_by_name(?)', [$name]);

        if (!$result) {
            return null;
        }

        // Create a User instance with only the public fields
        $user = new self();
        $user->id = $result->id;
        $user->name = $result->name;
        $user->created_at = $result->created_at;
        $user->exists = true;

        return $user;
    }

    /**
     * The attributes that are mass assignable.
     *
     * @var array<int, string>
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'user_token',
        'status',
        'credits',
        'debits',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var array<int, string>
     */
    protected $hidden = [
        'password',
        'remember_token',
        'user_token', // Secret UUID for RLS - never expose to frontend
    ];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'credits' => 'decimal:4',
            'debits' => 'decimal:4',
        ];
    }

    public function ledgerEntries(): HasMany
    {
        return $this->hasMany(BillingLedger::class);
    }

    public function getBalanceAttribute(): float
    {
        return (float) $this->credits - (float) $this->debits;
    }

    public function isPremium(): bool
    {
        return array_key_exists($this->status, config('services.billing_tiers', []));
    }

    public function getBillingMultiplier(): float
    {
        $tier = config("services.billing_tiers.{$this->status}");

        return $tier['multiplier'] ?? config('services.billing_tiers.budget.multiplier', 1.5);
    }
}
