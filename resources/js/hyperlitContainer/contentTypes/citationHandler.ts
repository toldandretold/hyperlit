/**
 * Citation content-type handler. priority 3. Build-only (no timestamp, no post-open,
 * no per-item permission — citations are not user-editable in the container).
 */
import type { ContentTypeHandler, BuildCtx } from './types';
import { buildCitationContent } from '../contentBuilders/displayCitations';

export const citationHandler: ContentTypeHandler = {
  type: 'citation',
  priority: 3,

  async buildContent(ct: any, ctx: BuildCtx): Promise<string> {
    return (await buildCitationContent(ct, ctx.db)) || '';
  },
};
