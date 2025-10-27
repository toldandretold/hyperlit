# User Page Implementation - Context for SPA Navigation Refactor

## What Was Implemented

### 1. User Page Structure (user.blade.php)
- **Created**: `resources/views/user.blade.php` - Separate template for user library pages
- **Structure**: Similar to `home.blade.php` but with user-specific customizations
- **Container**: Uses `.user-content-wrapper` (not `.home-content-wrapper`)
- **URL Pattern**: `/username` loads user's library page
- **Buttons**:
  - Public button: `data-content="{{ $book }}"` → loads `username` book
  - Private button: `data-content="{{ $book }}Private"` → loads `usernamePrivate` book

### 2. Backend (UserHomeServerController.php)
- `show()` method generates TWO books:
  - **Public book** (`username`): Contains `visibility='public'` library items
  - **Private book** (`usernamePrivate`): Contains `visibility='private'` library items (only if owner)
- `generateUserHomeBook($username, $isOwner, $visibility)`:
  - Filters library query by `visibility`
  - **Removed h1 header chunk** (handled by `#userLibraryContainer` in blade)
  - Creates empty state: `*no public hypertext*` or `*no private hypertext*`
- Book name logic: `$bookName = $visibility === 'private' ? $username . 'Private' : $username`

### 3. User Profile Metadata (userProfileEditor.js)
- **Storage**: Uses existing `library` table (title, note fields)
- **Title field**: Defaults to `"username's library"`, contenteditable, 150 char limit
- **Bio field**: Stored in `note`, contenteditable with placeholder, 500 char limit
- **Sync**: Direct to PostgreSQL `/api/db/library/upsert`, no IndexedDB for profile
- **Display**: Populated in `#userLibraryContainer` on page load
- **Authorization**: Only owner can edit

### 4. CSS & Layout Updates
- **Fixed header**: Added `.user-content-wrapper` styles matching homepage
- **Header spacing**: `fixHeaderSpacing()` recalculates after profile content loads
- **Placeholder CSS**: `.editable-field:empty::before` for bio placeholder text
- **Layout**: User pages use same fixed header + scrollable content pattern as homepage

### 5. JavaScript Module Updates
Added `.user-content-wrapper` recognition to:
- `lazyLoaderFactory.js` - Scrollable parent detection
- `scrolling.js` - Scroll parent detection
- `togglePerimeterButtons.js` - Button positioning
- `initializePage.js` - Homepage context detection
- `homepageDisplayUnit.js` - Header alignment

### 6. Route Configuration (routes/web.php)
```php
Route::get('/{identifier}', function(Request $request, $identifier) {
    if (User::where('name', $identifier)->exists()) {
        return app(\App\Http\Controllers\UserHomeServerController::class)->show($identifier);
    }
    return app(TextController::class)->show($request, $identifier);
})->where('identifier', '[A-Za-z0-9_-]+');
```

## Current SPA Navigation Structure

### Existing Pathways (NavigationManager.js)
1. `fresh-page-load` - Full page initialization
2. `create-new-book` - Home → Reader (full body)
3. `import-book` - Form → Reader (full body)
4. `book-to-book` - Reader → Reader (content only)
5. `book-to-home` - Reader → Home (full body)
6. `home-to-book` - Home → Reader (full body)

### Structure Detection (LinkNavigationHandler.js)
```javascript
static getPageStructure() {
  if (document.querySelector('.reader-content-wrapper')) return 'reader';
  if (document.querySelector('.home-content-wrapper')) return 'home';
  if (document.querySelector('.user-content-wrapper')) return 'user';
  return 'reader'; // fallback
}

static areStructuresCompatible(structure1, structure2) {
  if (structure1 === structure2) return true;
  // home and user are compatible
  const homeCompatible = ['home', 'user'];
  if (homeCompatible.includes(structure1) && homeCompatible.includes(structure2)) {
    return true;
  }
  return false;
}
```

## NEXT TASK: Simplify to Two Pathway Types

### Problem with Current Approach
- 6 separate pathways for every combination
- Adding user pages would require 6 more pathways
- Lots of duplication

### Proposed Simplified System

#### Two Core Pathway Types:

**1. `navigateToDifferentBladeTemplate`** (Full Body Replacement)
- Used when: `structure1 !== structure2 && !areStructuresCompatible(structure1, structure2)`
- Examples:
  - Reader → Home
  - Reader → User
  - Home → Reader
  - User → Reader
- Actions:
  - Fetch full HTML from server
  - Replace entire `<body>`
  - Re-initialize all page-specific JS
  - Update URL via pushState

**2. `navigateToSameBladeTemplate`** (Content-Only Replacement)
- Used when: `structure1 === structure2 || areStructuresCompatible(structure1, structure2)`
- Examples:
  - Reader → Reader (different book)
  - Home → Home (different filter)
  - User → User (different user)
  - Home ↔ User (compatible structures)
- Actions:
  - Remove existing `.main-content` containers
  - Create new content container with new book ID
  - Load content via `loadHyperText()`
  - Reset lazy loader
  - Update URL via pushState
  - **NO full body replacement**

### Structure Compatibility Matrix

```
         | reader | home | user |
---------|--------|------|------|
reader   | SAME   | DIFF | DIFF |
home     | DIFF   | SAME | SAME |  ← Compatible!
user     | DIFF   | SAME | SAME |  ← Compatible!
```

### Implementation Plan

**NavigationManager.js** should become:
```javascript
static async navigate(options = {}) {
  const currentStructure = LinkNavigationHandler.getPageStructure();
  const targetStructure = await this.detectTargetStructure(options.targetUrl);

  if (currentStructure === targetStructure ||
      LinkNavigationHandler.areStructuresCompatible(currentStructure, targetStructure)) {
    return await this.navigateToSameBladeTemplate(options);
  } else {
    return await this.navigateToDifferentBladeTemplate(options);
  }
}
```

**Key Question**: Can home/user transitions actually work with content-only replacement?
- **YES** if they share the same DOM structure (which they do)
- **YES** if initialization is the same (`initializeHomepage()` works for both)
- **YES** if `homepageDisplayUnit.js` handles both wrappers (which it does now)

### What Gets Preserved/Reset in Content-Only Transitions

**Preserved** (stays in DOM):
- Fixed header with buttons
- Perimeter buttons (home, new book)
- Page wrapper (`.home-content-wrapper` or `.user-content-wrapper`)

**Reset** (destroyed and recreated):
- `.main-content` div (gets new ID = new book)
- Lazy loader instance (disconnected, new one created)
- Mark listeners (re-attached to new content)
- Scroll sentinels (repositioned)

**For Home ↔ User transitions**:
- User profile editor initialized/destroyed as needed
- Header content (title/bio) updated or cleared
- Buttons stay but active state changes

## Files to Update for SPA Refactor

### Core Navigation Files
1. `NavigationManager.js` - Simplify to 2 pathway types
2. `LinkNavigationHandler.js` - Use structure compatibility for routing
3. `pathways/SameTemplateTransition.js` (new) - Consolidate book-to-book + home/user transitions
4. `pathways/DifferentTemplateTransition.js` (new) - Consolidate all template switches

### Potential Issues to Test
1. **User profile editor** - Does it properly initialize/destroy on user → user transitions?
2. **Header spacing** - Does it recalculate correctly on transitions?
3. **Button listeners** - Do they get properly cleaned up on transitions?
4. **Lazy loader** - Does resetCurrentLazyLoader() work for all scenarios?

## Database Schema Notes

### Library Table Fields Used
- `book` - Book identifier (username for user books)
- `title` - Used for user's library title
- `note` - Used for user bio
- `visibility` - 'public' or 'private'
- `creator` - Username of creator
- `listed` - false for user books

### Node Chunks for User Books
- `book = username` → public library items
- `book = usernamePrivate` → private library items
- Empty state creates 1 node with italic message
- No h1 header chunk (removed in this implementation)

## Testing Checklist for Next Session

- [ ] Home → Home (different filter) - content-only ✓
- [ ] User → User (different user) - content-only
- [ ] Home → User - content-only (compatible)
- [ ] User → Home - content-only (compatible)
- [ ] User → Reader - full body
- [ ] Reader → User - full body
- [ ] Profile editor initializes on user page load
- [ ] Profile editor cleans up on navigation away
- [ ] Public/Private buttons switch books correctly
- [ ] Empty state messages show correctly
- [ ] Header spacing recalculates on transitions

## Key Code Patterns

### How homepageDisplayUnit.js works (for reference):
```javascript
async function transitionToBookContent(bookId, showLoader = true) {
  // 1. Remove old content containers
  document.querySelectorAll('.main-content').forEach(content => content.remove());

  // 2. Create fresh container
  const wrapper = document.querySelector('.home-content-wrapper') ||
                  document.querySelector('.user-content-wrapper');
  const newDiv = document.createElement('div');
  newDiv.id = bookId;
  newDiv.className = 'main-content active-content';
  wrapper.appendChild(newDiv);

  // 3. Reset lazy loader
  resetCurrentLazyLoader();

  // 4. Load content
  await loadHyperText(bookId);
}
```

This pattern should be reusable for SameTemplateTransition!
