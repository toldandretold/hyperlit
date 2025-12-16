<?php

namespace App\Http\Requests;

use App\Rules\BookId;
use App\Rules\SafeString;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Http\Exceptions\HttpResponseException;

class NodeChunkUpsertRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Authorization handled by middleware and controller
        return true;
    }

    public function rules(): array
    {
        return [
            'book' => ['required', new BookId()],
            'nodes' => ['required', 'array'],
            'nodes.*.node_id' => ['required', 'string', 'max:100'],
            'nodes.*.startLine' => ['required', 'integer', 'min:0'],
            'nodes.*.content' => ['sometimes', 'nullable', 'string'],
            'nodes.*.plainText' => ['sometimes', 'nullable', 'string'],
        ];
    }

    public function getBookId(): string
    {
        return $this->validated()['book'];
    }

    public function getNodes(): array
    {
        return $this->validated()['nodes'];
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
