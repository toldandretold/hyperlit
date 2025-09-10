# Hierarchical Annotation System Implementation Guide

## Overview

The hierarchical annotation system transforms the current annotation storage from HTML text to a bookID-based system where each annotation becomes its own bookID with full lazy loading and editing capabilities. This enables infinite recursive annotations while maintaining a clean DOM structure limited to 2 visible levels.

## Architecture Changes

### Database Schema

#### PostgreSQL Migrations

1. **`2025_09_10_001000_add_node_id_to_node_chunks_table.php`**
   - Adds `node_id` column to `node_chunks` table
   - Creates unique index for efficient lookups

2. **`2025_09_10_002000_update_annotation_columns.php`**
   - Changes annotation columns from `text` to `varchar(1000)` for bookID references
   - Adds annotation fields to `footnotes` and `bibliography` tables

#### IndexedDB Structure

- **nodeChunks**: Now supports hierarchical bookIDs (e.g., "mainBook/timestamp")
- **hyperlights/hypercites/footnotes/references**: Annotation field stores CSV of bookIDs

### Key Components

#### 1. AnnotationContextManager (`annotationContextManager.js`)

Manages the context stack and drilling down into annotations:

```javascript
import { annotationContextManager } from './annotationContextManager.js';

// Get current context
const currentContext = annotationContextManager.getCurrentContext();

// Check if we can create child annotations
const canDrillDown = !annotationContextManager.isAtMaxDepth();

// Drill down into annotation
await annotationContextManager.drillDown(parentBookID, annotationBookID, container);

// Navigate back
annotationContextManager.navigateBack();
```

#### 2. BookID Generation (`bookIDGenerator.js`)

Utilities for generating and parsing hierarchical bookIDs:

```javascript
import { 
  generateAnnotationBookID, 
  parseBookID, 
  canCreateChildAnnotation 
} from './bookIDGenerator.js';

// Generate annotation bookID
const annotationBookID = generateAnnotationBookID('mainBook');
// Result: "mainBook/1672531200000"

// Parse bookID
const parsed = parseBookID('mainBook/1672531200000/1672531201000');
// Result: { isMain: false, depth: 2, parentBookID: "mainBook/1672531200000", ... }

// Check if can create child
const canCreate = canCreateChildAnnotation('mainBook/1672531200000');
// Result: true (depth < 2)
```

#### 3. Enhanced Annotation Saver (`annotation-saver.js`)

New nodeChunk-based saving system:

```javascript
import { saveAnnotationToNodeChunks } from './annotation-saver.js';

// Save annotation as nodeChunk
const annotationBookID = await saveAnnotationToNodeChunks(
  parentContentId,    // 'HL_123456789'
  parentContentType,  // 'highlight'
  annotationContent   // '<p>My annotation</p>'
);
```

#### 4. Unified Container (`unified-container.js`)

Enhanced to load annotation content:

```javascript
import { 
  loadAnnotationContent,
  handleUnifiedContentClickWithAnnotations 
} from './unified-container.js';

// Load annotations for a content item
await loadAnnotationContent(contentId, contentType, annotationBookIDs);

// Enhanced click handler with annotation support
await handleUnifiedContentClickWithAnnotations(element, highlightIds, newIds);
```

#### 5. Hierarchical Highlighting (`hyperLights.js`)

Updated mark click handler with drilling support:

- Detects current annotation context
- Creates child containers for drilling down
- Maintains 2-level UI constraint
- Supports navigation back

## Usage Examples

### Creating a Simple Annotation

```javascript
// User highlights text and adds annotation
const highlightId = 'HL_1672531200000';
const annotationContent = '<p>This is my annotation</p>';

// Save as nodeChunk with hierarchical bookID
const annotationBookID = await saveAnnotationToNodeChunks(
  highlightId,
  'highlight', 
  annotationContent
);
// Creates: "currentBookID/1672531201000"
```

### Drilling Down into Annotations

```javascript
// User clicks on a mark within an annotation
export async function handleMarkClick(event) {
  const currentContext = annotationContextManager.getCurrentContext();
  const isInAnnotation = currentContext !== 'main';
  
  if (isInAnnotation && canCreateChildAnnotation(currentContext)) {
    // Create child container for drilling down
    await createChildAnnotationContainer(highlightId, newIds);
  } else {
    // Use regular unified container
    await handleUnifiedContentClick(event.target, highlightIds, newIds);
  }
}
```

### Loading Annotation Content

```javascript
// Get annotation bookIDs for a highlight
const annotationBookIDs = await getAnnotationBookIDs(highlightId, 'highlight');
// Result: ["mainBook/1672531200000", "mainBook/1672531201000"]

// Load the annotation content
await loadAnnotationContent(highlightId, 'highlight', annotationBookIDs);
```

## CSS Classes and Styling

### Child Annotation Containers

```css
.hyperlit-container-child {
  background: rgba(255, 255, 255, 0.95);
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  padding: 15px;
  margin-top: 15px;
  max-height: 60vh;
}
```

### Annotation Containers

```css
.annotation-container {
  margin-bottom: 15px;
  padding: 10px;
  border-left: 3px solid #4CAF50;
  background: rgba(76, 175, 80, 0.05);
}
```

### Context States

```css
.frozen-context {
  opacity: 0.6;
  pointer-events: none;
}

.empty-annotation-placeholder {
  color: #888;
  font-style: italic;
  text-align: center;
}
```

## Database Operations

### Storing Hierarchical Annotations

1. **NodeChunk Creation**:
   ```javascript
   const nodeChunk = {
     book_id: "mainBook/1672531200000",  // Hierarchical bookID
     node_id: "node_uuid_123",           // Unique node identifier
     chunk_id: 0,
     startLine: "1",
     content: '<p id="1" data-node-id="node_uuid_123">content</p>'
   };
   ```

2. **Parent Reference Update**:
   ```javascript
   // Add annotation bookID to parent's annotation field (CSV)
   parentRecord.annotation = "mainBook/1672531200000,mainBook/1672531201000";
   ```

### Querying Annotations

```javascript
// Get nodeChunks for hierarchical bookID
const nodeChunks = await getNodeChunksFromIndexedDBHierarchical(
  "mainBook/1672531200000"
);

// Get annotation bookIDs for parent content
const bookIDs = await getAnnotationBookIDs(parentId, parentType);
```

## Testing

Run the test suite to verify implementation:

```javascript
import { HierarchicalAnnotationTests } from './test-hierarchical-annotations.js';

const tests = new HierarchicalAnnotationTests();
await tests.runAllTests();
```

## Migration Path

1. **Database Migration**: Run the provided migration files
2. **Update Imports**: Import new modules in existing files
3. **Replace Calls**: Update annotation saving calls to use `saveAnnotationToNodeChunks`
4. **Context Management**: Initialize `annotationContextManager` in main application
5. **UI Updates**: Use new CSS classes for child containers

## Success Criteria

- ✅ User can highlight text and add annotations
- ✅ Annotations are stored as separate bookIDs with nodeChunks
- ✅ User can highlight text within annotations (2-level nesting)
- ✅ Each annotation level has full lazy loading and editing capabilities
- ✅ DOM stays clean with maximum 2 visible levels
- ✅ All changes sync to PostgreSQL database
- ✅ Infinite logical nesting supported through hierarchical bookIDs

## Benefits

1. **Clean DOM**: Maximum 2 containers visible, regardless of logical nesting depth
2. **Full Functionality**: Each annotation level has complete highlighting/editing capabilities
3. **Performance**: Lazy loading prevents DOM bloat
4. **Scalability**: Infinite logical nesting through bookID hierarchy
5. **Data Integrity**: Proper database normalization with nodeChunk storage
6. **Maintainability**: Clear separation of concerns with context management

## Future Enhancements

- **Visual Breadcrumbs**: Show annotation hierarchy path
- **Quick Navigation**: Jump between annotation levels
- **Bulk Operations**: Apply changes across annotation hierarchies
- **Search Integration**: Search within annotation hierarchies
- **Export/Import**: Maintain hierarchy in data transfers