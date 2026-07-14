/**
 * Entry for the standalone harvest knowledge-network 3D page
 * (harvest-network.blade.php — non-SPA). Fetches the graph, then dynamically
 * imports the Three.js scene so the page shell paints before three's chunk
 * downloads. Three must never be imported statically here.
 */

// NOTE: this entry statically pulls the shared "indexeddb" chunk regardless of
// what it imports — rollup homes its __vitePreload helper there, and the
// dynamic import() of ./scene needs it. A logger import therefore costs nothing
// extra. (Fixing the helper's home means chunk surgery; not worth it for a
// page that immediately fetches three.js anyway.)
import { log } from '../utilities/logger';
import type { NetworkPayload } from './types';

declare global {
  interface Window {
    __harvestNetwork?: { rootBook: string; rootTitle: string };
  }
}

async function boot(): Promise<void> {
  const config = window.__harvestNetwork;
  const stage = document.getElementById('hn-stage');
  const status = document.getElementById('hn-status');
  if (!config || !stage) return;

  try {
    const resp = await fetch(
      `/api/harvest-network/${encodeURIComponent(config.rootBook)}/data`,
    );
    if (!resp.ok) throw new Error(`data fetch failed (${resp.status})`);
    const payload = (await resp.json()) as NetworkPayload;

    const { startScene } = await import('./scene');
    startScene(stage, payload);
    status?.remove();
  } catch (error) {
    log.error(`Harvest network failed to load: ${(error as Error).message}`, 'harvestNetwork3d');
    if (status) {
      status.textContent = 'The knowledge network could not be loaded. Try refreshing.';
    }
  }
}

void boot();
