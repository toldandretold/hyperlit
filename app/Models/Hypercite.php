<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Hypercite extends Model
{
    use HasFactory;

    protected $fillable = ['citation_id', 'hypercite_id', 'hypercited_text', 'href'];

    public function links()
    {
        return $this->hasMany(HyperciteLink::class, 'hypercite_id_x', 'hypercite_id');
    }
}
