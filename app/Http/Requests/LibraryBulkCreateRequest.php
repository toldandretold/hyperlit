<?php

namespace App\Http\Requests;

use App\Rules\BookId;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Http\Exceptions\HttpResponseException;

class LibraryBulkCreateRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Authorization handled by middleware
        return true;
    }

    public function rules(): array
    {
        return [
            'data' => ['required', 'array'],
            'data.book' => ['required', new BookId()],
            'data.title' => ['sometimes', 'nullable', 'string', 'max:500'],
            'data.author' => ['sometimes', 'nullable', 'string', 'max:255'],
            'data.type' => ['sometimes', 'nullable', 'string', 'max:50'],
            'data.timestamp' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'data.bibtex' => ['sometimes', 'nullable', 'string', 'max:100'],
            'data.visibility' => ['sometimes', 'in:public,private'],
            'data.listed' => ['sometimes', 'boolean'],
            'data.year' => ['sometimes', 'nullable', 'string', 'max:20'],
            'data.publisher' => ['sometimes', 'nullable', 'string', 'max:255'],
            'data.journal' => ['sometimes', 'nullable', 'string', 'max:255'],
        ];
    }

    /**
     * Get the book ID from validated data.
     */
    public function getBookId(): string
    {
        return $this->validated()['data']['book'];
    }

    /**
     * Get all validated library data.
     */
    public function getLibraryData(): array
    {
        return $this->validated()['data'];
    }

    protected function failedValidation(Validator $validator): void
    {
        throw new HttpResponseException(response()->json([
            'success' => false,
            'message' => 'Validation failed',
            'errors' => $validator->errors()
        ], 422));
    }
}
