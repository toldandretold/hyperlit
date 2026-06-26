/**
 * Citation content builders — barrel.
 *
 * Preserves the public surface the former `displayCitations.ts` exported, so every importer of
 * `'.../contentBuilders/displayCitations'` resolves unchanged. Split by citation kind: plain
 * bibliography reference cards vs inbound hypercite-citations (links pointing at a hypercite).
 */
export { buildCitationContent, resolveCitationButtonStatus } from './plainCitation';
export { buildHyperciteCitationContent, resolveButtonStatus } from './hyperciteCitation';
