/**
 * Content-type handler registry — the single ordered source of the five handlers.
 * The orchestrators (contentBuild / postOpen / permissions) consume this instead of
 * switching on `ct.type`. Adding a content type = add a handler module + register here.
 */
import type { ContentTypeHandler } from './types';
import { footnoteHandler } from './footnoteHandler';
import { citationHandler } from './citationHandler';
import { hyperciteCitationHandler } from './hyperciteCitationHandler';
import { hyperciteHandler } from './hyperciteHandler';
import { hyperlightHandler } from './hyperlightHandler';

/** All handlers, declaration order. */
export const CONTENT_TYPE_HANDLERS: ContentTypeHandler[] = [
  footnoteHandler,
  citationHandler,
  hyperciteCitationHandler,
  hyperciteHandler,
  hyperlightHandler,
];

const BY_TYPE = new Map<string, ContentTypeHandler>(
  CONTENT_TYPE_HANDLERS.map((h) => [h.type, h]),
);

/** Look up the handler for a content-type tag (undefined if unknown). */
export function getHandler(type: string): ContentTypeHandler | undefined {
  return BY_TYPE.get(type);
}

/** Priority for a content-type tag (999 for unknown, so it sorts last). */
export function priorityOf(type: string): number {
  return BY_TYPE.get(type)?.priority ?? 999;
}
