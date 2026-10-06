import { describe, expect, it } from 'vitest';
import registry from '../projects.json';
import schema from '../projects.schema.json';
import {
  findProject,
  LEGACY_PROJECT_ID,
  loadProjects,
  normalize,
  type Project,
  PROJECT_ID_PATTERN,
  projects,
  SOURCE_TYPES,
} from './projects.js';
import { versionSchemes } from './version-schemes.js';

// CI runs this file as its own "Validate projects.json" step.

// The projects allowed to tag request metrics with client IPs and user agents.
// Adding one is a privacy and cardinality decision, so it has to show up here
// as an explicit diff.
const CLIENT_IDENTITY_PROJECTS = ['immich'];

const entry = () => ({
  id: 'example',
  name: 'Example',
  source: { type: 'github-releases', repo: 'futo-org/example', repoId: 1 },
  tags: { pattern: String.raw`^v(?<version>\d+\.\d+\.\d+(?:-[\da-z.]+)?)$`, scheme: 'semver' },
  channels: { stable: [], beta: ['beta', 'rc'] } as Record<string, string[]>,
  defaultChannel: 'stable',
  analytics: { clientIdentity: false } as Record<string, unknown>,
  examples: { 'v1.0.0': { version: '1.0.0', channels: ['stable', 'beta'] } } as Record<string, unknown>,
});

const load = (...entries: unknown[]) => loadProjects({ projects: entries });

// Example tags that more than one project on the same source would take.
function overlappingClaims(list: readonly Project[]): string[] {
  // repoId, not the name, so a renamed or transferred repo is still one source.
  const sourceKey = (project: Project) => `${project.source.type}:${project.source.repoId}`;
  const overlaps: string[] = [];
  const sources = new Set(list.map((project) => sourceKey(project)));
  for (const source of sources) {
    const group = list.filter((project) => sourceKey(project) === source);
    const tags = new Set(group.flatMap((project) => Object.keys(project.examples)));
    for (const tag of tags) {
      const claimants = group.filter((project) => normalize(project, tag) !== null).map(({ id }) => id);
      if (claimants.length > 1) {
        overlaps.push(`${tag}: ${claimants.join(', ')}`);
      }
    }
  }
  return overlaps;
}

describe('projects.json', () => {
  it('passes the validator the worker runs', () => {
    expect(() => loadProjects(registry)).not.toThrow();
  });

  describe.each(projects.map((project) => [project.id, project] as const))('%s', (_, project) => {
    it.each(Object.entries(project.examples))('normalizes %s as its example says', (tag, expected) => {
      const normalized = normalize(project, tag);
      expect(normalized && { version: normalized.version, channels: normalized.channels }).toEqual(expected);
    });
  });

  it('lets no two projects on the same source claim an example tag', () => {
    expect(overlappingClaims(projects)).toEqual([]);

    const overlapping = load(
      { ...entry(), id: 'first' },
      { ...entry(), id: 'second', examples: { 'v1.0.0-rc.1': { version: '1.0.0-rc.1', channels: ['beta'] } } },
    );
    expect(overlappingClaims(overlapping)).toEqual(['v1.0.0: first, second', 'v1.0.0-rc.1: first, second']);

    const renamed = load(
      { ...entry(), id: 'first' },
      { ...entry(), id: 'second', source: { type: 'github-releases', repo: 'futo-org/renamed', repoId: 1 } },
    );
    expect(overlappingClaims(renamed)).toEqual(['v1.0.0: first, second']);
  });

  it('keeps Immich on exactly the channels the legacy /version route accepts', () => {
    const immich = findProject(LEGACY_PROJECT_ID);
    expect(immich).toBeDefined();
    expect(immich!.channels).toEqual(
      new Map([
        ['stable', []],
        ['rc', ['rc']],
      ]),
    );
    expect(immich!.defaultChannel).toBe('stable');
  });

  it("keeps the client identity and server user agent Immich's server analytics depend on", () => {
    expect(findProject(LEGACY_PROJECT_ID)?.analytics).toEqual({
      clientIdentity: true,
      serverUserAgentPrefix: 'immich-server/',
    });
  });

  it('only lets allowlisted projects record client identity', () => {
    const identified = projects.filter((project) => project.analytics.clientIdentity).map(({ id }) => id);
    expect(CLIENT_IDENTITY_PROJECTS).toEqual(expect.arrayContaining(identified));
  });
});

describe('projects.schema.json', () => {
  const { definitions } = schema;
  const project = definitions.project.properties;

  it("uses the validator's id pattern", () => {
    expect(project.id.pattern).toBe(PROJECT_ID_PATTERN.source);
  });

  it("lists the validator's version schemes", () => {
    expect(project.tags.properties.scheme.enum).toEqual(Object.keys(versionSchemes));
  });

  it("lists the validator's source types", () => {
    const sources = definitions as unknown as Record<string, { properties: { type: { const: string } } }>;
    const types = project.source.oneOf.map(
      ({ $ref }) => sources[$ref.replace('#/definitions/', '')].properties.type.const,
    );
    expect(types).toEqual(SOURCE_TYPES);
  });
});

describe('loadProjects', () => {
  it('compiles a valid entry', () => {
    const [project] = load(entry());
    expect(project.tags.pattern).toBeInstanceOf(RegExp);
    expect(project.channels).toEqual(
      new Map([
        ['stable', []],
        ['beta', ['beta', 'rc']],
      ]),
    );
  });

  it.each([
    ['a registry that is not an object', [], 'projects.json: must be an object'],
    ['a missing projects list', {}, 'projects.json: is missing "projects"'],
    ['an empty projects list', { projects: [] }, 'projects: must list at least one project'],
    ['an unknown top-level key', { projects: [entry()], other: true }, 'projects.json: has unknown key "other"'],
  ])('rejects %s', (_, input, message) => {
    expect(() => loadProjects(input)).toThrow(message);
  });

  it.each<[string, (project: ReturnType<typeof entry>) => unknown, string]>([
    [
      'an id that is not a lowercase slug',
      (p) => ({ ...p, id: 'Example' }),
      'projects[0].id: must be a string matching',
    ],
    ['a one-letter id', (p) => ({ ...p, id: 'e' }), 'projects[0].id: must be a string matching'],
    // Without the m flag, a JavaScript $ only matches at the very end of the input.
    ['an id with a trailing newline', (p) => ({ ...p, id: 'example\n' }), 'projects[0].id: must be a string matching'],
    [
      'a repo with a trailing newline',
      (p) => ({ ...p, source: { ...p.source, repo: 'futo-org/example\n' } }),
      'projects[0].source.repo: must be a string matching',
    ],
    [
      'a channel label with a trailing newline',
      (p) => ({ ...p, channels: { stable: [], beta: ['rc\n'] } }),
      'projects[0].channels.beta[0]: must be a string matching',
    ],
    ['an empty name', (p) => ({ ...p, name: ' ' }), 'projects[0].name: must be a non-empty string'],
    ['a misspelt key', (p) => ({ ...p, defualtChannel: 'stable' }), 'projects[0]: has unknown key "defualtChannel"'],
    ['a missing key', ({ examples: _, ...p }) => p, 'projects[0]: is missing "examples"'],
    [
      'a source type not supported yet',
      (p) => ({ ...p, source: { type: 'gitlab-releases', host: 'gitlab.futo.org', path: 'futo-notes/futo-notes' } }),
      'projects[0].source.type: must be one of github-releases',
    ],
    [
      'a GitHub source without a repo id',
      (p) => ({ ...p, source: { type: 'github-releases', repo: 'futo-org/example' } }),
      'projects[0].source: is missing "repoId"',
    ],
    [
      'a repo id that is not a positive integer',
      (p) => ({ ...p, source: { ...p.source, repoId: '1' } }),
      'projects[0].source.repoId: must be a positive integer',
    ],
    [
      'a repo that is not owner/name',
      (p) => ({ ...p, source: { ...p.source, repo: 'https://github.com/futo-org/example' } }),
      'projects[0].source.repo: must be a string matching',
    ],
    [
      'an unanchored pattern',
      (p) => ({ ...p, tags: { ...p.tags, pattern: 'v(?<version>.+)' } }),
      'projects[0].tags.pattern: must be anchored with ^ and $',
    ],
    [
      'a pattern that does not compile',
      (p) => ({ ...p, tags: { ...p.tags, pattern: '^v(?<version>[$' } }),
      'projects[0].tags.pattern: Invalid regular expression',
    ],
    [
      'a pattern without a version group',
      (p) => ({ ...p, tags: { ...p.tags, pattern: String.raw`^v(\d+\.\d+\.\d+)$` } }),
      'projects[0].tags.pattern: must capture the version in a group named "version"',
    ],
    [
      'an unknown scheme',
      (p) => ({ ...p, tags: { ...p.tags, scheme: 'calver' } }),
      'projects[0].tags.scheme: must be one of semver, dotted',
    ],
    ['no channels', (p) => ({ ...p, channels: {} }), 'projects[0].channels: must define at least one channel'],
    [
      'a channel name that is not a slug',
      (p) => ({ ...p, channels: { ...p.channels, Nightly: [] } }),
      'projects[0].channels["Nightly"]: must be a string matching',
    ],
    [
      'a label that is not letters only',
      (p) => ({ ...p, channels: { ...p.channels, beta: ['beta1'] } }),
      'projects[0].channels.beta[0]: must be a string matching',
    ],
    [
      'a label listed twice',
      (p) => ({ ...p, channels: { ...p.channels, beta: ['beta', 'beta'] } }),
      'projects[0].channels.beta: lists a label twice',
    ],
    [
      'a default channel that is not one of its channels',
      (p) => ({ ...p, defaultChannel: 'rc' }),
      `projects[0].defaultChannel: "rc" is not one of the project's channels`,
    ],
    [
      'a client identity that is not a boolean',
      (p) => ({ ...p, analytics: { clientIdentity: 'yes' } }),
      'projects[0].analytics.clientIdentity: must be a boolean',
    ],
    ['no examples', (p) => ({ ...p, examples: {} }), 'projects[0].examples: must list at least one tag'],
    [
      'an example on a channel the project lacks',
      (p) => ({ ...p, examples: { 'v1.0.0': { version: '1.0.0', channels: ['rc'] } } }),
      `projects[0].examples["v1.0.0"].channels[0]: must be one of the project's channels`,
    ],
    [
      'an example without a version',
      (p) => ({ ...p, examples: { 'v1.0.0': { channels: ['stable'] } } }),
      'projects[0].examples["v1.0.0"]: is missing "version"',
    ],
  ])('rejects %s', (_, mutate, message) => {
    expect(() => load(mutate(entry()))).toThrow(message);
  });

  it('rejects a duplicate id', () => {
    expect(() => load(entry(), entry())).toThrow('projects[1].id: duplicates "example"');
  });

  it('reports every problem at once', () => {
    expect(() => load({ ...entry(), id: 'Example', defaultChannel: 'rc' })).toThrow(
      /projects\[0]\.id: .*\n.*projects\[0]\.defaultChannel: /,
    );
  });
});

describe('normalize', () => {
  const channels = { stable: [], beta: ['beta'], rc: ['beta', 'rc'], all: ['*'] };
  const [project] = load({ ...entry(), channels, examples: { 'v1.0.0': null } });
  const [stableOnly] = load({ ...entry(), channels: { stable: [] }, examples: { 'v1.0.0': null } });

  it('returns the raw tag, its version group, the parsed version and the label', () => {
    expect(normalize(project, 'v1.2.0-rc.1')).toEqual({
      tag: 'v1.2.0-rc.1',
      version: '1.2.0-rc.1',
      parsed: { release: [1, 2, 0], prerelease: ['rc', '1'] },
      label: 'rc',
      channels: ['rc', 'all'],
    });
  });

  it('serves a stable release on every channel', () => {
    expect(normalize(project, 'v1.2.0')?.channels).toEqual(['stable', 'beta', 'rc', 'all']);
    expect(normalize(project, 'v1.2.0')?.label).toBeNull();
  });

  it('serves a prerelease only on the channels that admit its label', () => {
    expect(normalize(project, 'v1.2.0-beta.3')?.channels).toEqual(['beta', 'rc', 'all']);
    expect(normalize(project, 'v1.2.0-alpha.1')?.channels).toEqual(['all']);
    expect(normalize(project, 'v1.2.0-8')?.channels).toEqual(['all']);
  });

  it('reads -rc1 as an rc, never as stable', () => {
    expect(normalize(project, 'v1.2.0-rc1')).toMatchObject({ label: 'rc', channels: ['rc', 'all'] });
    expect(normalize(stableOnly, 'v1.2.0-rc1')?.channels).toEqual([]);
  });

  it('recognises a prerelease no channel admits, but serves it nowhere', () => {
    expect(normalize(stableOnly, 'v1.2.0-beta.1')).toMatchObject({ version: '1.2.0-beta.1', channels: [] });
  });

  it('ignores a tag the pattern does not match', () => {
    expect(normalize(project, 'release-1.2.0')).toBeNull();
    expect(normalize(project, 'v1.2.0_20-dev')).toBeNull();
  });

  it("parses the version with the project's scheme", () => {
    const tags = { pattern: String.raw`^(?<version>\d+(?:\.\d+){0,3}(?:-rc\d+)?)$`, scheme: 'dotted' };
    const [dotted] = load({ ...entry(), tags, channels, examples: { '0.1.29.1': null } });
    expect(normalize(dotted, '0.1.29.1')).toMatchObject({
      parsed: { release: [0, 1, 29, 1], prerelease: [] },
      label: null,
      channels: ['stable', 'beta', 'rc', 'all'],
    });
    expect(normalize(dotted, '0.1.29.1-rc2')).toMatchObject({ label: 'rc', channels: ['rc', 'all'] });

    const [semver] = load({ ...entry(), tags: { ...tags, scheme: 'semver' }, examples: { '0.1.29.1': null } });
    expect(normalize(semver, '0.1.29.1')).toBeNull();
  });

  it('ignores a version the scheme cannot parse', () => {
    const [loose] = load({ ...entry(), tags: { pattern: '^v(?<version>.+)$', scheme: 'semver' } });
    expect(normalize(loose, 'v1.2')).toBeNull();
    expect(normalize(loose, 'v01.2.3')).toBeNull();
  });

  it('only accepts a match of the whole tag', () => {
    const [alternation] = load({
      ...entry(),
      tags: { pattern: String.raw`^latest$|v(?<version>\d+\.\d+\.\d+)$`, scheme: 'semver' },
    });
    expect(normalize(alternation, 'v1.2.3')?.version).toBe('1.2.3');
    expect(normalize(alternation, 'release-v1.2.3')).toBeNull();
    expect(normalize(alternation, 'latest')).toBeNull();
  });
});
