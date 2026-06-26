/**
 * Hypercite content builders — barrel (display layer).
 *
 * The container only owns DISPLAY: the "Cited By" content builder + the panel button UX handlers
 * (which dynamically import the relocated logic). The hypercite LOGIC now lives in `hypercites/`
 * (health-check → `hypercites/healthCheck`, citedIN mutation → `hypercites/deletion`).
 */
export { buildHyperciteContent } from './hyperciteContent';
export {
  handleManageCitationsClick,
  handleHyperciteHealthCheck,
  handleHyperciteDelete,
} from './citationPanelButtons';
