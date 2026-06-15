/**
 * buildUnifiedContent — assembles the container's HTML from the present content types.
 * Thin orchestrator over the content-type registry: fetch each type's timestamp, sort by
 * (priority, timestamp), then concatenate each handler's buildContent output. Lives outside
 * index.ts so history.ts imports it here (not from ./index) — breaking the index↔history cycle.
 */
import { openDatabase } from '../indexedDB/index';
import { getHandler, priorityOf } from './contentTypes/registry';

export async function buildUnifiedContent(contentTypes: any, newHighlightIds: any = [], db: any = null, editModeEnabled: any = true, _hasAnyEditPermission: any = null) {
  console.log("🔨 Building unified content for types:", contentTypes.map((ct: any) => ct.type));

  let contentTypesWithTimestamps: any;

  // 🚀 PERFORMANCE: Skip timestamp fetching if only one content type (no sorting needed)
  if (contentTypes.length === 1) {
    console.log("⚡ Single content type - skipping timestamp fetch");
    contentTypesWithTimestamps = contentTypes.map((ct: any) => ({ ...ct, timestamp: 0 }));
  } else {
    // Fetch timestamps for each content type to sort chronologically
    const database = db || await openDatabase();

    contentTypesWithTimestamps = await Promise.all(
      contentTypes.map(async (contentType: any) => {
        let timestamp = 0; // Default to 0 for items without timestamps (footnotes, citations)
        try {
          const handler = getHandler(contentType.type);
          if (handler?.fetchTimestamp) {
            timestamp = await handler.fetchTimestamp(contentType, database);
          }
        } catch (error) {
          console.warn(`Error getting timestamp for ${contentType.type}:`, error);
        }
        return { ...contentType, timestamp };
      })
    );

    // Sort by content type priority (hypercite-citation → footnote → citation → hypercite →
    // highlight); within the same type, oldest first.
    contentTypesWithTimestamps.sort((a: any, b: any) => {
      const priorityA = priorityOf(a.type);
      const priorityB = priorityOf(b.type);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.timestamp - b.timestamp;
    });

    console.log("🕐 Content types sorted by timestamp:", contentTypesWithTimestamps.map((ct: any) => ({ type: ct.type, timestamp: ct.timestamp })));
  }

  let contentHtml = '';

  // Process each content type in (priority, chronological) order via its handler.
  for (const contentType of contentTypesWithTimestamps) {
    console.log(`🔨 Processing ${contentType.type} content...`);
    const handler = getHandler(contentType.type);
    if (!handler) continue;
    const html: any = await handler.buildContent(contentType, { db, editModeEnabled, newHighlightIds });
    if (html) {
      console.log(`✅ Added ${contentType.type} content (${html.length} chars)`);
      contentHtml += html;
    } else {
      console.warn(`⚠️ No ${contentType.type} content generated`);
    }
  }

  if (!contentHtml) {
    console.error("❌ No content was generated for any content type!");
    contentHtml = '<div class="error">No content available</div>';
  }

  console.log(`📦 Final content HTML (${contentHtml.length} chars):`, contentHtml);

  // Return just the content, not the full structure
  // The container already has the scroller, masks, etc.
  return contentHtml;
}
