/**
 * Hypercite content builders — barrel.
 *
 * Preserves the public surface the former `displayHypercites.ts` exported, so every importer of
 * `'.../contentBuilders/displayHypercites'` resolves unchanged. The implementation is split into
 * three concerns: content building, the health-check engine, and the citation-management UI (plus
 * a zero-import link-parsing leaf).
 */
export { buildHyperciteContent } from './hyperciteContent';
export { checkHyperciteExists } from './hyperciteHealthCheck';
export {
  handleManageCitationsClick,
  handleHyperciteHealthCheck,
  handleHyperciteDelete,
} from './hyperciteCitationManagement';
