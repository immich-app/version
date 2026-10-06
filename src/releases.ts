import { normalize, type NormalizedTag, type Project } from './projects.js';
import type { LatestRelease, ProjectRelease } from './types.js';
import { compareVersions } from './version-schemes.js';

export interface OrderedRelease extends NormalizedTag {
  published_at: string;
}

const compareText = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * The project's stored releases, newest first by its version scheme, never by
 * date. Each tag is normalized again, so a release the registry no longer
 * accepts drops out without a resync. Equal versions (rc2 and rc.2) put the
 * later published first, then order by tag so the result is stable.
 */
export function newestFirst(project: Project, releases: readonly ProjectRelease[]): OrderedRelease[] {
  const ordered = releases.flatMap(({ tag, published_at }) => {
    const normalized = normalize(project, tag);
    return normalized ? [{ ...normalized, published_at }] : [];
  });
  ordered.sort(
    (a, b) =>
      compareVersions(b.parsed, a.parsed) || compareText(b.published_at, a.published_at) || compareText(b.tag, a.tag),
  );
  return ordered;
}

/**
 * The newest release on each of the project's channels, with a key for every
 * channel: null when the channel has none, so a cache of it can tell an empty
 * channel from one it hasn't read.
 */
export function latestPerChannel(
  project: Project,
  releases: readonly ProjectRelease[],
): Map<string, LatestRelease | null> {
  const ordered = newestFirst(project, releases);
  return new Map(
    [...project.channels].map(([channel]) => {
      const newest = ordered.find(({ channels }) => channels.includes(channel));
      return [channel, newest ? { tag: newest.tag, version: newest.version, published_at: newest.published_at } : null];
    }),
  );
}
