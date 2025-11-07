# Hyperlights Module

This directory contains the reorganized hyperlight (text highlighting) functionality, previously contained in three monolithic files.

## Module Structure

```
hyperlights/
├── index.js (2.8 KB)              # Main entry point, re-exports all functions
├── annotations.js (4.8 KB)        # Annotation saving & management
├── annotationPaste.js (5.4 KB)    # Paste handling in highlight annotations
├── calculations.js (4.0 KB)       # Offset calculations & positioning
├── database.js (12.5 KB)          # IndexedDB CRUD operations
├── deletion.js (11.5 KB)          # Delete/hide operations & reprocessing
├── listeners.js (4.4 KB)          # Mark event listeners (click, hover)
├── marks.js (2.7 KB)              # Mark DOM manipulation & styling
├── selection.js (16 KB)           # Text selection & highlight controls
└── utils.js (2.6 KB)              # Helper utilities & ID generation
```

## Purpose of Each Module

### index.js
Main entry point that re-exports all functions for backward compatibility. Import from here:
```javascript
import { attachMarkListeners, openHighlightById } from './hyperlights/index.js';
```

### annotations.js
Handles saving and attaching listeners to annotation divs:
- `saveAnnotationToIndexedDB()` - Save annotation content
- `attachAnnotationListener()` - Attach input listener with debouncing
- `getAnnotationHTML()` - Extract annotation HTML

### annotationPaste.js
Handles pasting into highlight annotations (especially hypercites):
- `handleHighlightContainerPaste()` - Main paste handler
- `processPastedHyperciteInAnnotation()` - Process hypercite pastes
- `addHighlightContainerPasteListener()` - Attach paste listener

### calculations.js
Offset and positioning calculations:
- `calculateCleanTextOffset()` - Calculate text offset without HTML
- `getRelativeOffsetTop()` - Get element offset relative to container
- `isNumericalId()` - Check if ID is numerical
- `findContainerWithNumericalId()` - Find nearest numbered container

### database.js
All IndexedDB operations for hyperlights:
- `addToHighlightsTable()` - Create new highlight
- `updateNodeHighlight()` - Update node chunk with highlight
- `removeHighlightFromHyperlights()` - Delete from hyperlights table
- `removeHighlightFromNodeChunks()` - Remove from node chunks
- `removeHighlightFromNodeChunksWithDeletion()` - Remove with deletion flag

### deletion.js
Delete, hide, and reprocessing operations:
- `deleteHighlightById()` - Permanently delete highlight
- `hideHighlightById()` - Hide highlight (keeps in DB)
- `reprocessHighlightsForNodes()` - Recalculate overlapping highlights
- `unwrapMark()` - Remove mark wrapper from DOM

### listeners.js
Event listener management:
- `attachMarkListeners()` - Attach listeners to all marks
- `handleMarkClick()` - Click handler
- `handleMarkHover()` / `handleMarkHoverOut()` - Hover handlers
- `addTouchAndClickListener()` - Unified touch/click with debouncing

### marks.js
Mark element manipulation:
- `modifyNewMarks()` - Apply classes and attributes to new marks
- `unwrapMark()` - Remove mark wrapper preserving content
- `formatRelativeTime()` - Format timestamp as relative time

### selection.js
Text selection and highlighting UI:
- `handleSelection()` - Show/hide highlight buttons on selection
- `initializeHighlightingControls()` - Initialize controls for book
- `cleanupHighlightingControls()` - Cleanup listeners
- `createHighlightHandler()` - Create new highlight
- `deleteHighlightHandler()` - Delete highlight via button

### utils.js
Utility functions:
- `generateHighlightID()` - Generate unique HL_* ID
- `openHighlightById()` - Open highlight container (legacy)
- `attachPlaceholderBehavior()` - Placeholder for empty annotations

## Migration from Old Files

**Before:**
```javascript
// Old imports (1442-line file)
import { attachMarkListeners } from './hyperLights.js';
import { attachAnnotationListener } from './annotationSaver.js';
import { addHighlightContainerPasteListener } from './hyperLightsListener.js';
```

**After:**
```javascript
// New imports (all from index.js)
import { 
  attachMarkListeners,
  attachAnnotationListener,
  addHighlightContainerPasteListener
} from './hyperlights/index.js';
```

All exports are available from `index.js` for backward compatibility.

## Benefits

✅ **Clear separation of concerns** - Each module has a single responsibility  
✅ **Easy navigation** - Find code by module name  
✅ **Better for code review** - Smaller, focused files  
✅ **Easier testing** - Test modules independently  
✅ **LLM-friendly** - Modules fit in context windows  
✅ **No naming conflicts** - `annotationPaste.js` vs root `paste.js`

## Development

When adding new highlight functionality:
1. Determine which module it belongs to
2. Add the function to that module
3. Export it from `index.js` if needed externally
4. Update this README

---

Generated: 2025-11-07
