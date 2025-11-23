-- Test Data for Migration Command
-- Purpose: Create OLD system data to test migrate:embedded-annotations command
--
-- This creates:
-- - A test book with 4 nodes
-- - Embedded hyperlights/hypercites arrays in nodes table (OLD system)
-- - Corresponding records in hyperlights/hypercites tables WITHOUT charData (OLD system)
-- - Multi-node highlight to test append logic
--
-- Run with: psql -U samuelnicholls -d my_laravel_db -f database/test_migration_data.sql

BEGIN;

-- Set variables for consistency
\set book 'test_migration_book'
\set node1_uuid 'test_migration_book_node1_uuid123'
\set node2_uuid 'test_migration_book_node2_uuid456'
\set node3_uuid 'test_migration_book_node3_uuid789'
\set node4_uuid 'test_migration_book_node4_uuidabc'

-- Clean up any existing test data
DELETE FROM nodes WHERE book = 'test_migration_book';
DELETE FROM hyperlights WHERE book = 'test_migration_book';
DELETE FROM hypercites WHERE book = 'test_migration_book';
DELETE FROM library WHERE book = 'test_migration_book';

-- Create library entry
INSERT INTO library (
    book,
    title,
    author,
    bibtex,
    timestamp,
    visibility,
    listed,
    raw_json,
    created_at,
    updated_at
) VALUES (
    'test_migration_book',
    'Test Migration Book',
    'Test Author',
    '@book{test_migration_book, author = {Test Author}, title = {Test Migration Book}, year = {2025}}',
    FLOOR(EXTRACT(EPOCH FROM NOW())),
    'private',
    true,
    '{}'::jsonb,
    NOW(),
    NOW()
);

-- Node 1: Single hyperlight + Single hypercite
INSERT INTO nodes (
    book,
    chunk_id,
    "startLine",
    node_id,
    content,
    "plainText",
    type,
    footnotes,
    hyperlights,
    hypercites,
    raw_json,
    created_at,
    updated_at
) VALUES (
    'test_migration_book',
    0,
    100,
    'test_migration_book_node1_uuid123',
    '<p id="100" data-node-id="test_migration_book_node1_uuid123">This is the first paragraph for testing.</p>',
    'This is the first paragraph for testing.',
    'p',
    '[]'::jsonb,
    '[{"highlightID": "HL_SINGLE_TEST", "charStart": 0, "charEnd": 4}]'::jsonb,
    '[{"hyperciteId": "HC_SINGLE_TEST", "charStart": 10, "charEnd": 15, "relationshipStatus": "single", "citedIN": [], "time_since": 1234567890}]'::jsonb,
    '{}'::jsonb,
    NOW(),
    NOW()
);

-- Node 2: Multi-node highlight (Part 1)
INSERT INTO nodes (
    book,
    chunk_id,
    "startLine",
    node_id,
    content,
    "plainText",
    type,
    footnotes,
    hyperlights,
    hypercites,
    raw_json,
    created_at,
    updated_at
) VALUES (
    'test_migration_book',
    0,
    101,
    'test_migration_book_node2_uuid456',
    '<p id="101" data-node-id="test_migration_book_node2_uuid456">Second paragraph with multi-node highlight.</p>',
    'Second paragraph with multi-node highlight.',
    'p',
    '[]'::jsonb,
    '[{"highlightID": "HL_MULTI_TEST", "charStart": 0, "charEnd": 6}]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    NOW(),
    NOW()
);

-- Node 3: Multi-node highlight (Part 2) + Multi-node hypercite (Part 1)
INSERT INTO nodes (
    book,
    chunk_id,
    "startLine",
    node_id,
    content,
    "plainText",
    type,
    footnotes,
    hyperlights,
    hypercites,
    raw_json,
    created_at,
    updated_at
) VALUES (
    'test_migration_book',
    0,
    102,
    'test_migration_book_node3_uuid789',
    '<p id="102" data-node-id="test_migration_book_node3_uuid789">Third paragraph continues the highlight and starts a citation.</p>',
    'Third paragraph continues the highlight and starts a citation.',
    'p',
    '[]'::jsonb,
    '[{"highlightID": "HL_MULTI_TEST", "charStart": 0, "charEnd": 5}]'::jsonb,
    '[{"hyperciteId": "HC_MULTI_TEST", "charStart": 20, "charEnd": 28, "relationshipStatus": "single", "citedIN": [], "time_since": 1234567891}]'::jsonb,
    '{}'::jsonb,
    NOW(),
    NOW()
);

-- Node 4: Multi-node hypercite (Part 2)
INSERT INTO nodes (
    book,
    chunk_id,
    "startLine",
    node_id,
    content,
    "plainText",
    type,
    footnotes,
    hyperlights,
    hypercites,
    raw_json,
    created_at,
    updated_at
) VALUES (
    'test_migration_book',
    0,
    103,
    'test_migration_book_node4_uuidabc',
    '<p id="103" data-node-id="test_migration_book_node4_uuidabc">Fourth paragraph finishes the citation.</p>',
    'Fourth paragraph finishes the citation.',
    'p',
    '[]'::jsonb,
    '[]'::jsonb,
    '[{"hyperciteId": "HC_MULTI_TEST", "charStart": 0, "charEnd": 6, "relationshipStatus": "single", "citedIN": [], "time_since": 1234567891}]'::jsonb,
    '{}'::jsonb,
    NOW(),
    NOW()
);

-- Create hyperlights in normalized table WITHOUT charData (OLD system format)
-- HL_SINGLE_TEST
INSERT INTO hyperlights (
    book,
    hyperlight_id,
    node_id,
    "charData",
    "highlightedText",
    "highlightedHTML",
    annotation,
    "startChar",
    "endChar",
    "startLine",
    raw_json,
    created_at,
    updated_at,
    creator,
    creator_token,
    time_since,
    hidden
) VALUES (
    'test_migration_book',
    'HL_SINGLE_TEST',
    NULL,  -- OLD: No node_id array
    '{}'::jsonb,  -- OLD: Empty charData (simulating pre-migration state)
    'This',
    'This',
    '',
    0,
    4,
    '100',
    '{}'::jsonb,
    NOW(),
    NOW(),
    NULL,
    NULL,  -- Anonymous user (legacy record)
    FLOOR(EXTRACT(EPOCH FROM NOW())),
    false
);

-- HL_MULTI_TEST (will be updated by migration to include both nodes)
INSERT INTO hyperlights (
    book,
    hyperlight_id,
    node_id,
    "charData",
    "highlightedText",
    "highlightedHTML",
    annotation,
    "startChar",
    "endChar",
    "startLine",
    raw_json,
    created_at,
    updated_at,
    creator,
    creator_token,
    time_since,
    hidden
) VALUES (
    'test_migration_book',
    'HL_MULTI_TEST',
    NULL,  -- OLD: No node_id array
    '{}'::jsonb,  -- OLD: Empty charData (simulating pre-migration state)
    'Second Third',
    'Second Third',
    '',
    0,
    6,
    '101',
    '{}'::jsonb,
    NOW(),
    NOW(),
    NULL,
    NULL,  -- Anonymous user (legacy record)
    FLOOR(EXTRACT(EPOCH FROM NOW())),
    false
);

-- Create hypercites in normalized table WITHOUT charData (OLD system format)
-- HC_SINGLE_TEST
INSERT INTO hypercites (
    book,
    "hyperciteId",
    node_id,
    "charData",
    "hypercitedText",
    "hypercitedHTML",
    "citedIN",
    "relationshipStatus",
    "startChar",
    "endChar",
    raw_json,
    created_at,
    updated_at,
    time_since
) VALUES (
    'test_migration_book',
    'HC_SINGLE_TEST',
    NULL,  -- OLD: No node_id array
    '{}'::jsonb,  -- OLD: Empty charData (simulating pre-migration state)
    'first',
    'first',
    '[]'::jsonb,
    'single',
    10,
    15,
    '{}'::jsonb,
    NOW(),
    NOW(),
    1234567890
);

-- HC_MULTI_TEST (will be updated by migration to include both nodes)
INSERT INTO hypercites (
    book,
    "hyperciteId",
    node_id,
    "charData",
    "hypercitedText",
    "hypercitedHTML",
    "citedIN",
    "relationshipStatus",
    "startChar",
    "endChar",
    raw_json,
    created_at,
    updated_at,
    time_since
) VALUES (
    'test_migration_book',
    'HC_MULTI_TEST',
    NULL,  -- OLD: No node_id array
    '{}'::jsonb,  -- OLD: Empty charData (simulating pre-migration state)
    'citation Fourth',
    'citation Fourth',
    '[]'::jsonb,
    'single',
    20,
    28,
    '{}'::jsonb,
    NOW(),
    NOW(),
    1234567891
);

COMMIT;

-- Verification queries
SELECT 'Nodes created:' as info;
SELECT book, "startLine", node_id,
       jsonb_array_length(COALESCE(hyperlights, '[]'::jsonb)) as hl_count,
       jsonb_array_length(COALESCE(hypercites, '[]'::jsonb)) as hc_count
FROM nodes
WHERE book = 'test_migration_book'
ORDER BY "startLine";

SELECT '' as blank;
SELECT 'Hyperlights (before migration):' as info;
SELECT hyperlight_id, node_id, "charData", "startLine"
FROM hyperlights
WHERE book = 'test_migration_book';

SELECT '' as blank;
SELECT 'Hypercites (before migration):' as info;
SELECT "hyperciteId", node_id, "charData", "startChar", "endChar"
FROM hypercites
WHERE book = 'test_migration_book';

SELECT '' as blank;
SELECT 'Expected after migration:' as info;
SELECT 'HL_SINGLE_TEST should have: node_id = ["test_migration_book_node1_uuid123"], charData with 1 entry' as expected
UNION ALL
SELECT 'HL_MULTI_TEST should have: node_id = ["test_migration_book_node2_uuid456", "test_migration_book_node3_uuid789"], charData with 2 entries'
UNION ALL
SELECT 'HC_SINGLE_TEST should have: node_id = ["test_migration_book_node1_uuid123"], charData with 1 entry'
UNION ALL
SELECT 'HC_MULTI_TEST should have: node_id = ["test_migration_book_node3_uuid789", "test_migration_book_node4_uuidabc"], charData with 2 entries';
