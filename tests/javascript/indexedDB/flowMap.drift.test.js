/**
 * Drift gate for the IndexedDB flow map (mirrors test_pipeline_map.py and
 * PipelineMapDriftTest.php): the filesystem and flowMap.ts must agree.
 *
 *   - a new module that isn't placed in the map  → orphan failure
 *   - a map entry whose file was deleted/moved   → stale failure
 *
 * Paths are compared WITHOUT extension so .js → .ts renames don't churn the map.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_STAGES } from '../../../resources/js/indexedDB/flowMap';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../resources/js/indexedDB',
);

function modulesOnDisk(dir = ROOT) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...modulesOnDisk(full));
    } else if (/\.(js|ts)$/.test(entry.name)) {
      found.push(
        path.relative(ROOT, full).replace(/\.(js|ts)$/, '').split(path.sep).join('/'),
      );
    }
  }
  return found;
}

const placed = FLOW_STAGES.flatMap(stage => stage.modules.map(m => m.path));
const onDisk = modulesOnDisk();

describe('flowMap drift gate', () => {
  it('places every module on disk (no orphans)', () => {
    const orphans = onDisk.filter(p => !placed.includes(p)).sort();
    expect(orphans, 'modules on disk missing from flowMap.ts — place them in a stage').toEqual([]);
  });

  it('has no stale placements (every map entry exists on disk)', () => {
    const stale = placed.filter(p => !onDisk.includes(p)).sort();
    expect(stale, 'flowMap.ts entries with no file on disk — remove or fix the path').toEqual([]);
  });

  it('places each module exactly once', () => {
    const dupes = placed.filter((p, i) => placed.indexOf(p) !== i).sort();
    expect(dupes).toEqual([]);
  });

  it('every stage and module carries a plain-language note', () => {
    for (const stage of FLOW_STAGES) {
      expect(stage.id, 'stage id').toBeTruthy();
      expect(stage.title, `stage ${stage.id} title`).toBeTruthy();
      expect(stage.plain, `stage ${stage.id} plain note`).toBeTruthy();
      for (const mod of stage.modules) {
        expect(mod.plain, `plain note for ${mod.path}`).toBeTruthy();
      }
    }
  });
});
