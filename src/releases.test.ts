import { describe, expect, it } from 'vitest';
import { legacyProject, loadProjects, type Project } from './projects.js';
import { latestPerChannel, newestFirst, retractedReleases, skippedTags } from './releases.js';
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

const tagsOf = (releases: ProjectRelease[]) => releases.map(({ tag }) => tag);

describe('retractedReleases', () => {
  const stored = [
    row('v1.2.0', '2025-03-01T00:00:00Z'),
    row('v1.1.0', '2025-02-01T00:00:00Z'),
    row('v1.0.0', '2025-01-01T00:00:00Z'),
  ];
  it('takes down every stored release a complete listing lacks', () => {
    const fetched = { releases: [row('v1.2.0', '2025-03-01T00:00:00Z')], complete: true };
    expect(tagsOf(retractedReleases(fetched, stored))).toEqual(['v1.1.0', 'v1.0.0']);
  });

  it('puts the newest published first, so a sync that runs out of checks leaves the oldest', () => {
    const fetched = { releases: [row('v1.3.0', '2025-04-01T00:00:00Z')], complete: true };
    const [newest, middle, oldest] = stored;
    expect(tagsOf(retractedReleases(fetched, [oldest, row('v0.9.0'), newest, middle]))).toEqual([
      'v1.2.0',
      'v1.1.0',
      'v1.0.0',
      'v0.9.0',
    ]);
  });

  it('takes nothing down when the listing stopped at its page cap', () => {
    const fetched = {
      releases: [row('v1.2.0', '2025-03-01T00:00:00Z'), row('v1.0.5', '2025-01-15T00:00:00Z')],
      complete: false,
    };
    expect(retractedReleases(fetched, stored)).toEqual([]);
  });

  it('keeps a release created before the cap but published after the oldest listed one', () => {
    // GitHub lists by creation date: v1.1.5 was drafted long ago and published
    // lately, so it sits past the cap though its publish date is in the window.
    const fetched = {
      releases: [row('v1.2.0', '2025-03-01T00:00:00Z'), row('v1.0.5', '2025-01-15T00:00:00Z')],
      complete: false,
    };
    const lateDraft = row('v1.1.5', '2025-04-01T00:00:00Z');
    expect(retractedReleases(fetched, [...stored, lateDraft])).not.toContainEqual(lateDraft);
  });

  it('takes down a release without a publish date that a complete listing lacks', () => {
    const fetched = { releases: [row('v1.2.0', '2025-03-01T00:00:00Z')], complete: true };
    expect(tagsOf(retractedReleases(fetched, [row('v0.9.0')]))).toEqual(['v0.9.0']);
  });

  it("makes every stored release a candidate when a complete listing is empty, so a project's last release can go", () => {
    expect(tagsOf(retractedReleases({ releases: [], complete: true }, stored))).toEqual(tagsOf(stored));
  });

  it('makes nothing a candidate when an empty listing stopped short', () => {
    expect(retractedReleases({ releases: [], complete: false }, stored)).toEqual([]);
  });

  it("keeps a release that is still listed, even if the project's pattern no longer takes it", () => {
    const fetched = { releases: [...stored, row('nightly', '2025-04-01T00:00:00Z')], complete: true };
    expect(retractedReleases(fetched, [...stored, row('v1.3.0_1-dev')])).toEqual([row('v1.3.0_1-dev')]);
  });
});

describe('skippedTags', () => {
  const stored = [row('v1.2.0', '2025-03-01T00:00:00Z')];

  it('counts unrecognized releases newer than the newest recognized one', () => {
    const fetched = [
      row('release-1.4.0', '2025-05-01T00:00:00Z'),
      row('release-1.3.0', '2025-04-01T00:00:00Z'),
      row('v1.2.0', '2025-03-01T00:00:00Z'),
      row('v1.0.0_1-dev', '2024-01-01T00:00:00Z'),
    ];
    expect(skippedTags(immich, [immich], fetched, stored)).toBe(2);
  });

  it('stops counting once a newer release is recognized', () => {
    const fetched = [row('v1.3.0', '2025-06-01T00:00:00Z'), row('release-1.3.0', '2025-04-01T00:00:00Z')];
    expect(skippedTags(immich, [immich], fetched, stored)).toBe(0);
  });

  it('ignores a recognized release without a publish date when finding the newest', () => {
    const fetched = [row('release-1.3.0', '2025-04-01T00:00:00Z'), row('v1.2.1')];
    expect(skippedTags(immich, [immich], fetched, stored)).toBe(1);
  });

  it('counts every dated release when the project recognizes none', () => {
    expect(skippedTags(immich, [immich], [row('release-1.0.0', '2025-01-01T00:00:00Z'), row('draft')], [])).toBe(1);
  });

  it('leaves out the tags of another project on the same source', () => {
    const fetched = [row('v2.0.0-beta.1', '2025-05-01T00:00:00Z'), row('v2.0.0-alpha.1', '2025-04-01T00:00:00Z')];
    expect(skippedTags(immich, [immich], fetched, stored)).toBe(2);
    expect(skippedTags(immich, [immich, loose], fetched, stored)).toBe(1);
  });
});
