/**
 * Hypercite-citation content-type handler (the INBOUND side of a two-way citation —
 * a link pointing at someone else's hypercite). priority 1 (shown first). Build delegates
 * to displayCitations; postOpen defers the access/ancestor/node-precache button resolution.
 */
import type { ContentTypeHandler, BuildCtx, PostOpenCtx } from './types';
import { buildHyperciteCitationContent } from '../contentBuilders/displayCitations';

export const hyperciteCitationHandler: ContentTypeHandler = {
  type: 'hypercite-citation',
  priority: 1,

  async buildContent(ct: any, ctx: BuildCtx): Promise<string> {
    return (await buildHyperciteCitationContent(ct, ctx.db)) || '';
  },

  async postOpen(ct: any, ctx: PostOpenCtx): Promise<void> {
    // Pass the container element so resolveButtonStatus can target it directly,
    // even before `.open` has been applied (stacked layers defer that to rAF).
    const containerEl = ctx.options.containerEl || null;
    const { resolveButtonStatus }: any = await import('../contentBuilders/displayCitations');
    resolveButtonStatus(ct, ctx.db, containerEl);
  },
};
