<?php

namespace App\Http\Requests;

use App\Rules\BookId;
use App\Rules\SafeString;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Http\Exceptions\HttpResponseException;

class LibraryUpsertRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Authorization handled by middleware and controller
        return true;
    }

    public function rules(): array
    {
        return [
            'data' => ['required', 'array'],
            'data.book' => ['required', new BookId()],
            // 🔒 SECURITY: SafeString validation prevents XSS in text fields
            'data.title' => ['sometimes', 'nullable', 'string', 'max:500', new SafeString(500)],
            'data.author' => ['sometimes', 'nullable', 'string', 'max:255', new SafeString(255)],
            'data.visibility' => ['sometimes', 'in:public,private,deleted'],
            'data.listed' => ['sometimes', 'boolean'],
            'data.timestamp' => ['sometimes', 'integer', 'min:0'],
            'data.type' => ['sometimes', 'nullable', 'string', 'max:50', new SafeString(50)],
            'data.bibtex' => ['sometimes', 'nullable', 'string', 'max:100', new SafeString(100)],
            'data.url' => ['sometimes', 'nullable', 'url', 'max:2000'],
            'data.year' => ['sometimes', 'nullable', 'string', 'max:20'],
            'data.journal' => ['sometimes', 'nullable', 'string', 'max:255', new SafeString(255)],
            'data.pages' => ['sometimes', 'nullable', 'string', 'max:50'],
            'data.publisher' => ['sometimes', 'nullable', 'string', 'max:255', new SafeString(255)],
            'data.school' => ['sometimes', 'nullable', 'string', 'max:255', new SafeString(255)],
            'data.note' => ['sometimes', 'nullable', 'string', 'max:5000', new SafeString(5000)],
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
     * Get all validated data fields.
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
