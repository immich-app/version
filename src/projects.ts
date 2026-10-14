import registry from '../projects.json';
import {
  isVersionSchemeName,
  prereleaseLabel,
  versionSchemes,
  type ParsedVersion,
  type VersionSchemeName,
} from './version-schemes.js';

// Ids are permanent: they are the URL segment, the D1 key and the
// version_project metric tag.
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL_PATTERN = /^[a-z]+$/;
const GITHUB_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
// A lowercase hostname, without a scheme or a port.
const GITLAB_HOST_PATTERN = /^[a-z\d-]+(?:\.[a-z\d-]+)+$/;
// group/name, with any subgroups between.
const GITLAB_PATH_PATTERN = /^[\w.-]+(?:\/[\w.-]+)+$/;
// A user agent product name and its slash, which the version follows.
export const USER_AGENT_PREFIX_PATTERN = /^[\w.-]+\/$/;

// The project behind the legacy /version and /v1/docs/versions routes.
export const LEGACY_PROJECT_ID = 'immich';

export interface GitHubReleasesSource {
  type: 'github-releases';
  // owner/name
  repo: string;
  // GitHub's repository id, which survives renames and transfers.
  repoId: number;
}

// A GitLab project's releases, read with its read token (src/gitlab-auth.ts).
export interface GitLabReleasesSource {
  type: 'gitlab-releases';
  // The instance's hostname, e.g. gitlab.futo.org.
  host: string;
  // The project's full path: group/name, with any subgroups between. For logs
  // and docs: the project is read and routed by its id.
  path: string;
  // GitLab's project id, which survives renames and transfers. It is unique
  // only on its instance.
  projectId: number;
}

// One member per source type, told apart by `type`.
export type ProjectSource = GitHubReleasesSource | GitLabReleasesSource;

export interface Example {
  version: string;
  channels: string[];
}

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
  // `pattern` matches the whole tag and captures the version in a group named
  // `version`, which `scheme` parses.
  tags: { pattern: RegExp; scheme: VersionSchemeName };
  // Each channel serves every stable release, plus the prereleases whose
  // label it lists. `*` admits every prerelease.
  channels: ReadonlyMap<string, readonly string[]>;
  defaultChannel: string;
  // What the project's clients start their user agent with, followed by their
  // version: immich-server/ for immich-server/3.3.1. The analytics dashboard
  // counts requests that send it as the project's clients.
  userAgentPrefix: string;
  // Tag -> the version and channels it must normalize to, or null if the
  // project ignores it. src/projects.test.ts checks every one.
  examples: Readonly<Record<string, Example | null>>;
}

export interface NormalizedTag {
  tag: string;
  // The pattern's version group, e.g. 3.3.0 for v3.3.0.
  version: string;
  parsed: ParsedVersion;
  // null for a stable release, see prereleaseLabel().
  label: string | null;
  // The channels that serve it, in registry order. Empty for a prerelease
  // whose label no channel admits: it is the project's, but never served.
  channels: string[];
}

/**
 * Reads a tag the way its project's registry entry says to: the pattern must
 * match the whole tag, and its version group must parse under the project's
 * scheme. Returns null for any tag that isn't one of the project's releases.
 */
export function normalize(project: Project, tag: string): NormalizedTag | null {
  const match = project.tags.pattern.exec(tag);
  const version = match?.groups?.version;
  if (version === undefined || match?.[0] !== tag) {
    return null;
  }

  const parsed = versionSchemes[project.tags.scheme].parse(version);
  if (!parsed) {
    return null;
  }

  const label = prereleaseLabel(parsed);
  const channels = [...project.channels]
    .filter(([_, labels]) => label === null || labels.includes('*') || labels.includes(label))
    .map(([channel]) => channel);
  return { tag, version, parsed, label, channels };
}

export const findProject = (id: string, list: readonly Project[] = projects) =>
  list.find((project) => project.id === id);

/**
 * Identifies a source: a GitHub repository by its id and a GitLab project by
 * its host and id, which survive renames and transfers. Projects with the same
 * key read the same releases, each keeping only the tags its pattern matches.
 */
export function sourceKey(source: ProjectSource): string {
  switch (source.type) {
    case 'github-releases': {
      return `${source.type}:${source.repoId}`;
    }
    case 'gitlab-releases': {
      return `${source.type}:${source.host}:${source.projectId}`;
    }
  }
}

// The projects that read their releases from the same source as `project`, itself included.
export const sameSource = (project: Project, list: readonly Project[] = projects) =>
  list.filter((other) => sourceKey(other.source) === sourceKey(project.source));

/**
 * The projects whose releases come from the GitHub repository a webhook payload
 * names. Its numeric id decides: ids are permanent, so a delivery still finds
 * its projects after a rename or a transfer, and a repository that takes up an
 * old name never reaches them. Only a payload without an id is matched by its
 * name, ignoring case; any other id that isn't a number matches nothing. A match takes every project on that source (sameSource()).
 */
export function projectsForGitHubRepository(repository: unknown, list: readonly Project[] = projects): Project[] {
  const { id, full_name } = (typeof repository === 'object' && repository !== null ? repository : {}) as {
    id?: unknown;
    full_name?: unknown;
  };
  const name = typeof full_name === 'string' ? full_name.toLowerCase() : undefined;
  // Any id but a number is malformed and matches nothing, never falling back to the name.
  const matches = (source: GitHubReleasesSource) =>
    id === undefined || id === null ? name === source.repo.toLowerCase() : id === source.repoId;
  const matched = new Set(
    list
      .filter(({ source }) => source.type === 'github-releases' && matches(source))
      .map(({ source }) => sourceKey(source)),
  );
  return list.filter(({ source }) => matched.has(sourceKey(source)));
}

/**
 * The projects whose releases come from the GitLab project a webhook names:
 * the one with that numeric id on that host, since ids are permanent but only
 * unique on their instance. A match takes every project on that source
 * (sameSource()).
 */
export function projectsForGitLabProject(
  host: string,
  projectId: unknown,
  list: readonly Project[] = projects,
): Project[] {
  const matched = new Set(
    list
      .filter(
        ({ source }) => source.type === 'gitlab-releases' && source.host === host && source.projectId === projectId,
      )
      .map(({ source }) => sourceKey(source)),
  );
  return list.filter(({ source }) => matched.has(sourceKey(source)));
}

/**
 * Validates a registry with projects.json's shape and compiles its patterns.
 * Throws one error that lists every problem. projects.schema.json describes
 * the same shape for editors, but this is the check that counts.
 */
export function loadProjects(input: unknown): Project[] {
  const problems = new Problems();
  const root = problems.object('projects.json', input, ['projects'], ['$schema']);
  const entries = root ? problems.array('projects', root.projects) : undefined;
  if (entries?.length === 0) {
    problems.add('projects', 'must list at least one project');
  }

  const loaded = (entries ?? []).map((entry, index) => loadProject(problems, `projects[${index}]`, entry));
  const ids = new Set<string>();
  for (const [index, project] of loaded.entries()) {
    if (project && ids.has(project.id)) {
      problems.add(`projects[${index}].id`, `duplicates "${project.id}"`);
    }
    if (project) {
      ids.add(project.id);
    }
  }

  const valid = loaded.filter((project) => project !== undefined);
  if (problems.list.length > 0 || valid.length !== loaded.length) {
    throw new Error(`Invalid project registry:\n${problems.list.map((problem) => `  ${problem}`).join('\n')}`);
  }
  return valid;
}

type JsonObject = Record<string, unknown>;

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

// Collects every problem with its path, so one run reports them all.
class Problems {
  readonly list: string[] = [];

  add(path: string, message: string) {
    this.list.push(`${path}: ${message}`);
  }

  record(path: string, value: unknown): JsonObject | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.add(path, 'must be an object');
      return undefined;
    }
    return value as JsonObject;
  }

  // An object with exactly the required keys, plus any of the optional ones.
  object(path: string, value: unknown, required: string[], optional: string[] = []): JsonObject | undefined {
    const object = this.record(path, value);
    if (!object) {
      return undefined;
    }
    const before = this.list.length;
    for (const key of required) {
      if (!hasOwn(object, key)) {
        this.add(path, `is missing "${key}"`);
      }
    }
    for (const key of Object.keys(object)) {
      if (!required.includes(key) && !optional.includes(key)) {
        this.add(path, `has unknown key "${key}"`);
      }
    }
    return this.list.length === before ? object : undefined;
  }

  array(path: string, value: unknown): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.add(path, 'must be an array');
      return undefined;
    }
    return value;
  }

  string(path: string, value: unknown, pattern?: RegExp): string | undefined {
    if (typeof value !== 'string' || !(pattern ?? /\S/).test(value)) {
      this.add(path, pattern ? `must be a string matching ${pattern}` : 'must be a non-empty string');
      return undefined;
    }
    return value;
  }

  // A forge's numeric id for a repository or project.
  id(path: string, value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      this.add(path, 'must be a positive integer');
      return undefined;
    }
    return value;
  }
}

function loadProject(problems: Problems, path: string, value: unknown): Project | undefined {
  const entry = problems.object(path, value, [
    'id',
    'name',
    'source',
    'tags',
    'channels',
    'defaultChannel',
    'userAgentPrefix',
    'examples',
  ]);
  if (!entry) {
    return undefined;
  }

  const id = problems.string(`${path}.id`, entry.id, PROJECT_ID_PATTERN);
  const name = problems.string(`${path}.name`, entry.name);
  const source = loadSource(problems, `${path}.source`, entry.source);
  const tags = loadTags(problems, `${path}.tags`, entry.tags);
  const channels = loadChannels(problems, `${path}.channels`, entry.channels);
  const defaultChannel = problems.string(`${path}.defaultChannel`, entry.defaultChannel, CHANNEL_PATTERN);
  if (channels && defaultChannel && !channels.has(defaultChannel)) {
    problems.add(`${path}.defaultChannel`, `"${defaultChannel}" is not one of the project's channels`);
  }
  const userAgentPrefix = problems.string(`${path}.userAgentPrefix`, entry.userAgentPrefix, USER_AGENT_PREFIX_PATTERN);
  const examples = loadExamples(problems, `${path}.examples`, entry.examples, channels);

  return id && name && source && tags && channels && defaultChannel && userAgentPrefix && examples
    ? { id, name, source, tags, channels, defaultChannel, userAgentPrefix, examples }
    : undefined;
}

type SourceLoaders = {
  [Type in ProjectSource['type']]: (
    problems: Problems,
    path: string,
    value: unknown,
  ) => Extract<ProjectSource, { type: Type }> | undefined;
};

// A new source type is a new member of ProjectSource plus its loader here.
const sourceLoaders: SourceLoaders = {
  'github-releases'(problems, path, value) {
    const source = problems.object(path, value, ['type', 'repo', 'repoId']);
    if (!source) {
      return;
    }
    const repo = problems.string(`${path}.repo`, source.repo, GITHUB_REPO_PATTERN);
    const repoId = problems.id(`${path}.repoId`, source.repoId);
    return repo && repoId ? { type: 'github-releases', repo, repoId } : undefined;
  },
  'gitlab-releases'(problems, path, value) {
    const source = problems.object(path, value, ['type', 'host', 'path', 'projectId']);
    if (!source) {
      return;
    }
    const host = problems.string(`${path}.host`, source.host, GITLAB_HOST_PATTERN);
    const projectPath = problems.string(`${path}.path`, source.path, GITLAB_PATH_PATTERN);
    const projectId = problems.id(`${path}.projectId`, source.projectId);
    return host && projectPath && projectId
      ? { type: 'gitlab-releases', host, path: projectPath, projectId }
      : undefined;
  },
};

export const SOURCE_TYPES = Object.keys(sourceLoaders) as ProjectSource['type'][];

function loadSource(problems: Problems, path: string, value: unknown): ProjectSource | undefined {
  const type = problems.record(path, value)?.type;
  if (typeof type !== 'string' || !hasOwn(sourceLoaders, type)) {
    problems.add(`${path}.type`, `must be one of ${SOURCE_TYPES.join(', ')}`);
    return undefined;
  }
  return sourceLoaders[type as ProjectSource['type']](problems, path, value);
}

function loadTags(problems: Problems, path: string, value: unknown): Project['tags'] | undefined {
  const tags = problems.object(path, value, ['pattern', 'scheme']);
  if (!tags) {
    return undefined;
  }

  const scheme = problems.string(`${path}.scheme`, tags.scheme);
  if (scheme && !isVersionSchemeName(scheme)) {
    problems.add(`${path}.scheme`, `must be one of ${Object.keys(versionSchemes).join(', ')}`);
  }

  const source = problems.string(`${path}.pattern`, tags.pattern);
  if (!source) {
    return undefined;
  }
  if (!source.startsWith('^') || !source.endsWith('$')) {
    problems.add(`${path}.pattern`, 'must be anchored with ^ and $');
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(source);
  } catch (error) {
    problems.add(`${path}.pattern`, error instanceof Error ? error.message : 'does not compile');
    return undefined;
  }
  // A match's groups object has every named group as a key, matched or not.
  if (!hasOwn(new RegExp(`|${source}`).exec('')?.groups ?? {}, 'version')) {
    problems.add(`${path}.pattern`, 'must capture the version in a group named "version"');
  }

  return scheme && isVersionSchemeName(scheme) ? { pattern, scheme } : undefined;
}

function loadChannels(problems: Problems, path: string, value: unknown): Project['channels'] | undefined {
  const object = problems.record(path, value);
  if (!object) {
    return undefined;
  }

  const before = problems.list.length;
  const channels = new Map<string, readonly string[]>();
  for (const [channel, list] of Object.entries(object)) {
    problems.string(`${path}["${channel}"]`, channel, CHANNEL_PATTERN);
    const labels = problems.array(`${path}.${channel}`, list) ?? [];
    for (const [index, label] of labels.entries()) {
      if (label !== '*') {
        problems.string(`${path}.${channel}[${index}]`, label, LABEL_PATTERN);
      }
    }
    if (new Set(labels).size !== labels.length) {
      problems.add(`${path}.${channel}`, 'lists a label twice');
    }
    channels.set(channel, labels as string[]);
  }
  if (channels.size === 0) {
    problems.add(path, 'must define at least one channel');
  }
  return problems.list.length === before ? channels : undefined;
}

function loadExamples(
  problems: Problems,
  path: string,
  value: unknown,
  channels: Project['channels'] | undefined,
): Project['examples'] | undefined {
  const object = problems.record(path, value);
  if (!object) {
    return undefined;
  }

  const before = problems.list.length;
  if (Object.keys(object).length === 0) {
    problems.add(path, 'must list at least one tag');
  }
  for (const [tag, example] of Object.entries(object)) {
    const tagPath = `${path}["${tag}"]`;
    const expected = example === null ? undefined : problems.object(tagPath, example, ['version', 'channels']);
    if (!expected) {
      continue;
    }
    problems.string(`${tagPath}.version`, expected.version);
    const listed = problems.array(`${tagPath}.channels`, expected.channels) ?? [];
    for (const [index, channel] of listed.entries()) {
      if (typeof channel !== 'string' || (channels && !channels.has(channel))) {
        problems.add(`${tagPath}.channels[${index}]`, "must be one of the project's channels");
      }
    }
  }
  return problems.list.length === before ? (object as Project['examples']) : undefined;
}

// The registry, validated when the worker loads it. CI runs the same checks
// first (src/projects.test.ts), so a bad entry never reaches a deploy.
export const projects: readonly Project[] = loadProjects(registry);

export function requireProject(id: string, list: readonly Project[] = projects): Project {
  const project = findProject(id, list);
  if (!project) {
    throw new Error(`projects.json must register "${id}"`);
  }
  return project;
}

// The project the legacy /version and /v1/docs/versions routes serve.
// src/projects.test.ts keeps it on exactly the channels /version accepts.
export const legacyProject = requireProject(LEGACY_PROJECT_ID);
