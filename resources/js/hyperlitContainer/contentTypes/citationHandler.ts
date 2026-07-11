/**
 * Citation content-type handler. priority 3. Build delegates to displayCitations; postOpen
 * resolves the "Open source" button's locked/enabled state once the container is visible
 * (an external cited book's visibility isn't known at build — see resolveCitationButtonStatus).
 */
import type { ContentTypeHandler, BuildCtx, PostOpenCtx } from './types';
import { buildCitationContent } from '../contentBuilders/displayCitations';

export const citationHandler: ContentTypeHandler = {
  type: 'citation',
  priority: 3,

  async buildContent(ct: any, ctx: BuildCtx): Promise<string> {
    return (await buildCitationContent(ct, ctx.db)) || '';
  },

  async postOpen(ct: any, ctx: PostOpenCtx): Promise<void> {
    // Pass the container element so the resolver can target it directly, even before
    // `.open` has been applied (stacked layers defer that to rAF).
    const containerEl = ctx.options.containerEl || null;
    const { resolveCitationButtonStatus, wireReferenceVerifyButtons }: any = await import('../contentBuilders/displayCitations');
    resolveCitationButtonStatus(ct, ctx.db, containerEl);
    // Author's canonical-match confirm (Yes/No) buttons need click handlers once visible.
    wireReferenceVerifyButtons(containerEl);
  },
};
