/**
 * Hypercite content-type handler (the SOURCE two-way-citation underline in this document).
 * priority 4. Build delegates to displayHypercites; fetchTimestamp reads time_since
 * (from the cached record when available). Read-only — no post-open, no permission.
 */
import type { ContentTypeHandler, BuildCtx } from './types';
import { buildHyperciteContent } from '../contentBuilders/displayHypercites';

export const hyperciteHandler: ContentTypeHandler = {
  type: 'hypercite',
  priority: 4,

  async fetchTimestamp(ct: any, db: any): Promise<number> {
    // 🚀 Use cached data if available
    if (ct.cachedData && ct.cachedData.time_since) {
      return ct.cachedData.time_since;
    }
    // Fall back to query if not cached
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");
    const req = index.get(ct.hyperciteId);
    const result: any = await new Promise((resolve: any) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return result && result.time_since ? result.time_since : 0;
  },

  async buildContent(ct: any, ctx: BuildCtx): Promise<string> {
    return (await buildHyperciteContent(ct, ctx.db)) || '';
  },
};
