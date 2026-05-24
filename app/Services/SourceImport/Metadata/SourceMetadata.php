<?php

namespace App\Services\SourceImport\Metadata;

/**
 * Normalised metadata about a citable work, sourced from any identifier-keyed API.
 *
 * Shape mirrors OpenAlexService::normaliseWork() — same keys, same semantics —
 * so downstream code (library stub creation, canonical_source upsert) can consume
 * it without caring which resolver produced it. Wrapped in a class purely so the
 * type signature is honest about what comes out of a MetadataResolver; the data
 * itself is still array-shaped under the hood.
 */
final class SourceMetadata
{
    public function __construct(
        public readonly array $data,
        /** Where the metadata came from, e.g. 'openalex', 'arxiv'. */
        public readonly string $source,
    ) {}

    public function title(): ?string { return $this->data['title'] ?? null; }
    public function author(): ?string { return $this->data['author'] ?? null; }
    public function year(): ?int { return $this->data['year'] ?? null; }
    public function doi(): ?string { return $this->data['doi'] ?? null; }
    public function openalexId(): ?string { return $this->data['openalex_id'] ?? null; }
    public function pdfUrl(): ?string { return $this->data['pdf_url'] ?? null; }
    public function oaUrl(): ?string { return $this->data['oa_url'] ?? null; }
    public function isOpenAccess(): bool { return (bool) ($this->data['is_oa'] ?? false); }
    public function license(): ?string { return $this->data['work_license'] ?? null; }
    public function oaStatus(): ?string { return $this->data['oa_status'] ?? null; }
}
