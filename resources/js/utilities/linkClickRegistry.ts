/**
 * linkClickRegistry — zero-import DI leaf for content link-click handling.
 *
 * lazyLoader attaches a per-container click listener but must NOT statically import
 * SPA/navigation/LinkNavigationHandler (that creates a lazyLoader↔navigation static cycle).
 * Instead lazyLoader calls handleContentLinkClick() here; LinkNavigationHandler registers
 * its handler at module-load via registerLinkClickHandler(). Backed by globalThis so the
 * registration survives code-split chunk boundaries.
 */

type LinkClickHandler = (event: any) => any;

const KEY = '__hyperlitLinkClickHandler';

/**
 * Register the handler that resolves content link clicks (called by LinkNavigationHandler).
 */
export function registerLinkClickHandler(handler: LinkClickHandler): void {
  (globalThis as any)[KEY] = handler;
}

/**
 * Resolve a content link click through the registered handler.
 * Returns the handler's result (truthy = handled), or false if none is registered yet.
 */
export async function handleContentLinkClick(event: any): Promise<any> {
  const handler: LinkClickHandler | undefined = (globalThis as any)[KEY];
  if (typeof handler !== 'function') {
    return false;
  }
  return await handler(event);
}
