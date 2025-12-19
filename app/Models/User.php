<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
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
        ];
    }
}
