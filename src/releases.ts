import { normalize, type NormalizedTag, type Project } from './projects.js';
import type { FetchedReleases } from './sources.js';
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

/**
 * The stored releases a complete listing left out, which the source may have
 * taken down: deleted, or turned back into drafts. They are only candidates,
 * for the source to confirm (ReleaseSource.confirmRetracted()): a release
 * deleted while the listing was paged shifts the rest, so one that still exists
 * can go unlisted. The newest published come first, so those a sync has no
 * checks left for are the oldest. A kept candidate is one again on the next
 * full sync, so the older ones wait for as long as MAX_RETRACTION_CHECKS newer
 * ones stay unlisted and unconfirmed.
 *
 * A listing that stopped at its page cap leaves nothing out. Its order is the
 * source's (GitHub's is by creation date, not publish date), so a release
 * published lately but created long ago can sit past the cap, and no stored
 * date tells it apart from a retracted one. A complete listing with nothing in
 * it makes every stored release a candidate, so a project's last release can
 * still be taken down; a source that briefly lists nothing can't empty the
 * project, because each candidate still has to be confirmed gone.
 */
export function retractedReleases(fetched: FetchedReleases, stored: readonly ProjectRelease[]): ProjectRelease[] {
  if (!fetched.complete) {
    return [];
  }

  const listed = new Set(fetched.releases.map(({ tag }) => tag));
  const unlisted = stored.filter(({ tag }) => !listed.has(tag));
  unlisted.sort((a, b) => compareText(b.published_at, a.published_at) || compareText(b.tag, a.tag));
  return unlisted;
}

/**
 * How many fetched releases no project on the source recognizes, among those
 * newer than the newest release this project does. A project that changes its
 * tag format makes this rise with every release while nothing new is stored,
 * which the version-project-tags-skipped alert watches for. Older unrecognized
 * tags, such as Immich's early -dev builds, don't count, and neither do the
 * tags of another project on the same source. `stored` is what the sync left
 * stored, so a release it just took down can't hide the ones after it.
 */
export function skippedTags(
  project: Project,
  sameSource: readonly Project[],
  fetched: readonly ProjectRelease[],
  stored: readonly ProjectRelease[],
): number {
  const recognized = [...stored, ...fetched].filter(({ tag }) => normalize(project, tag));
  // An undated release has no place in time, so it can't hide newer ones (and
  // one NaN would make Math.max NaN, which no comparison passes).
  const dated = recognized.map(({ published_at }) => time(published_at)).filter((at) => Number.isFinite(at));
  const newest = Math.max(-Infinity, ...dated);
  return fetched.filter(
    ({ tag, published_at }) => time(published_at) > newest && sameSource.every((other) => !normalize(other, tag)),
  ).length;
}

// A release's publish time, NaN when it has none, which no comparison passes.
const time = (publishedAt: string) => Date.parse(publishedAt);
