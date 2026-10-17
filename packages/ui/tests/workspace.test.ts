import { describe, expect, it } from 'vitest';
import {
  checkedConnection,
  libraryLocation,
  localLibraries,
  parentPrefix,
  viewerIds,
} from '../src/workspace';
import type { Library } from '../src/model';

const local: Library = {
  id: 'local',
  name: 'Local',
  root: 'D:\\Photos',
  created_at: '',
  source_kind: 'local',
};
const remote: Library = {
  ...local,
  id: 'remote',
  source_kind: 'webdav',
  root: 'D:\\AppCache\\private',
  source_endpoint: 'https://nas.local/dav',
  source_prefix: 'trips/2026/',
};
describe('workspace boundaries', () => {
  it('offers only visible local libraries as import destinations, including legacy libraries', () => {
    expect(
      localLibraries([
        local,
        remote,
        { ...local, id: 'legacy', source_kind: undefined },
        { ...local, id: 'direct', storage_id: null },
        { ...local, id: 'hidden', hidden: true },
      ]).map((item) => item.id),
    ).toEqual(['local', 'legacy', 'direct']);
  });
  it('shows actual remote source locations instead of implementation cache paths', () => {
    expect(libraryLocation(remote)).toBe('https://nas.local/dav / trips/2026/');
    expect(libraryLocation(remote)).not.toContain('AppCache');
    expect(libraryLocation(local)).toBe(local.root);
  });
  it('does not report a successfully returned failed connection check as success', () => {
    expect(
      checkedConnection({
        id: 'nas',
        connected: false,
        credential_status: 'missing',
        checked_at: '',
        error: 'Unauthorized',
      }),
    ).toEqual({ ok: false, message: 'Unauthorized' });
  });
  it('keeps viewer ordering stable and always includes the requested image', () => {
    expect(viewerIds('b', ['a', 'b', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(viewerIds('x', ['a', 'b'])).toEqual(['x', 'a', 'b']);
    expect(parentPrefix('trips/2026/')).toBe('trips/');
    expect(parentPrefix('trips/')).toBe('');
  });
});
