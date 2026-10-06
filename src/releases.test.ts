import { describe, expect, it } from 'vitest';
import { legacyProject, loadProjects, type Project } from './projects.js';
import { latestPerChannel, newestFirst } from './releases.js';
import type { ProjectRelease } from './types.js';

const row = (tag: string, published_at = ''): ProjectRelease => ({
  tag,
  published_at,
  source_id: '',
  forge_prerelease: null,
});

const immich = legacyProject;

const project = (id: string, tags: { pattern: string; scheme: string }, channels: Record<string, string[]>) =>
  loadProjects({
    projects: [
      {
        id,
        name: id,
        source: { type: 'github-releases', repo: `futo-org/${id}`, repoId: 1 },
        tags,
        channels,
        defaultChannel: 'stable',
        analytics: { clientIdentity: false },
        examples: { 'v1.0.0': null },
      },
    ],
  })[0];

// Takes -rc2, -rc.2 and -beta.1 prereleases, which Immich's pattern rejects.
const loose = project(
  'loose',
  { pattern: String.raw`^v(?<version>\d+\.\d+\.\d+(?:-(?:rc\.?\d+|beta\.\d+))?)$`, scheme: 'semver' },
  { stable: [], beta: ['beta', 'rc'], rc: ['rc'] },
);

const dotted = project(
  'dotted',
  { pattern: String.raw`^(?<version>\d+(?:\.\d+){0,3}(?:-rc\d+)?)$`, scheme: 'dotted' },
  { stable: [], rc: ['rc'] },
);

const tags = (project: Project, releases: ProjectRelease[]) =>
  Object.fromEntries([...latestPerChannel(project, releases)].map(([channel, latest]) => [channel, latest?.tag]));

describe('latestPerChannel', () => {
  it("has a key for every one of the project's channels, null when it has no release", () => {
    expect(latestPerChannel(immich, [])).toEqual(
      new Map([
        ['stable', null],
        ['rc', null],
      ]),
    );
    expect(latestPerChannel(immich, [row('v3.3.0-rc.1')]).get('stable')).toBeNull();
  });

  it('returns the raw tag, the version the pattern captured and the publish date', () => {
    expect(latestPerChannel(immich, [row('v3.2.4', '2026-09-01T00:00:00Z')]).get('stable')).toEqual({
      tag: 'v3.2.4',
      version: '3.2.4',
      published_at: '2026-09-01T00:00:00Z',
    });
  });

  it('orders by version, never by publish date', () => {
    const releases = [
      row('v1.4.1', '2025-01-01T00:00:00Z'),
      row('v1.4.0', '2025-02-01T00:00:00Z'),
      row('v3.0.0-rc.2', '2025-03-01T00:00:00Z'),
      row('v2.8.1', '2025-04-01T00:00:00Z'),
    ];
    expect(tags(immich, releases)).toEqual({ stable: 'v2.8.1', rc: 'v3.0.0-rc.2' });
  });

  it('ranks rc.10 above rc.9', () => {
    expect(tags(immich, [row('v1.0.0-rc.10'), row('v1.0.0-rc.9'), row('v1.0.0-rc.2')]).rc).toBe('v1.0.0-rc.10');
  });

  it('ranks rc10 above rc9 and rc2, unlike plain semver', () => {
    expect(tags(loose, [row('v1.0.0-rc9'), row('v1.0.0-rc10'), row('v1.0.0-rc2')]).rc).toBe('v1.0.0-rc10');
    expect(tags(dotted, [row('0.1.29.1-rc9'), row('0.1.29.1-rc10'), row('0.1.29')]).rc).toBe('0.1.29.1-rc10');
  });

  it('ranks a stable release above its own rcs', () => {
    expect(tags(immich, [row('v3.0.0-rc.2'), row('v3.0.0'), row('v3.0.0-rc.1')])).toEqual({
      stable: 'v3.0.0',
      rc: 'v3.0.0',
    });
    expect(tags(dotted, [row('0.1.29.1-rc2'), row('0.1.29.1')]).rc).toBe('0.1.29.1');
  });

  it('never serves an -rc1 tag as stable', () => {
    expect(tags(loose, [row('v1.0.0'), row('v1.1.0-rc1')])).toEqual({
      stable: 'v1.0.0',
      beta: 'v1.1.0-rc1',
      rc: 'v1.1.0-rc1',
    });
    // Immich's pattern only takes -rc.N, so an -rc1 tag isn't one of its releases at all.
    expect(tags(immich, [row('v1.0.0'), row('v1.1.0-rc1')])).toEqual({ stable: 'v1.0.0', rc: 'v1.0.0' });
  });

  it('serves a prerelease only on the channels that admit its label', () => {
    expect(tags(loose, [row('v1.0.0'), row('v1.1.0-beta.1')])).toEqual({
      stable: 'v1.0.0',
      beta: 'v1.1.0-beta.1',
      rc: 'v1.0.0',
    });
  });

  it('skips stored tags the registry no longer accepts', () => {
    expect(tags(immich, [row('v1.0.0'), row('v9.0.0-dev'), row('v9.0.0_1-dev'), row('latest')])).toEqual({
      stable: 'v1.0.0',
      rc: 'v1.0.0',
    });
  });

  it('serves the later published of two equal versions', () => {
    const earlier = row('v1.0.0-rc.2', '2025-01-01T00:00:00Z');
    const later = row('v1.0.0-rc2', '2025-01-02T00:00:00Z');
    expect(tags(loose, [earlier, later]).rc).toBe('v1.0.0-rc2');
    expect(tags(loose, [later, earlier]).rc).toBe('v1.0.0-rc2');
  });
});

describe('newestFirst', () => {
  it("orders the project's releases newest first, whatever order they were stored in", () => {
    const releases = [row('v1.10.0'), row('v1.9.0'), row('v1.10.0-rc.1'), row('v2.0.0-rc.1'), row('v1.0.0_1-dev')];
    expect(newestFirst(immich, releases).map(({ tag }) => tag)).toEqual([
      'v2.0.0-rc.1',
      'v1.10.0',
      'v1.10.0-rc.1',
      'v1.9.0',
    ]);
  });

  it('keeps the normalized version, channels and publish date', () => {
    expect(newestFirst(immich, [row('v1.10.0-rc.1', '2025-01-01T00:00:00Z')])).toEqual([
      {
        tag: 'v1.10.0-rc.1',
        version: '1.10.0-rc.1',
        parsed: { release: [1, 10, 0], prerelease: ['rc', '1'] },
        label: 'rc',
        channels: ['rc'],
        published_at: '2025-01-01T00:00:00Z',
      },
    ]);
  });
});
