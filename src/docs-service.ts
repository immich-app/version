import { SemVer, gte } from 'semver';
import type { IMetricsRepository } from './metrics.js';
import type { Project } from './projects.js';
import type { IReleaseRepository } from './release-repository.js';
import { newestFirst } from './releases.js';
import type { DocsVersion, ProjectRelease } from './types.js';

const FIRST_ARCHIVED = new SemVer('1.100.0');
const FIRST_DOCS_SUBDOMAIN = new SemVer('1.143.1');

export class DocsService {
  constructor(
    private releaseRepository: IReleaseRepository,
    private metrics: IMetricsRepository,
  ) {}

  async getArchivedVersions(project: Project): Promise<DocsVersion[]> {
    const releases = await this.metrics.monitorAsyncFunction({ name: 'd1_get_docs_versions' }, () =>
      this.releaseRepository.list(project.id),
    )();

    return latestPatchPerMinor(project, releases, FIRST_ARCHIVED).map((version) => toDocsVersion(version));
  }
}

// The newest stable patch of every major.minor at or above `min`, newest first.
function latestPatchPerMinor(project: Project, releases: readonly ProjectRelease[], min: SemVer): SemVer[] {
  const minors = new Set<string>();
  const versions: SemVer[] = [];
  for (const { parsed } of newestFirst(project, releases)) {
    const [major, minor = 0, patch = 0] = parsed.release;
    const version = new SemVer(`${major}.${minor}.${patch}`);
    if (parsed.prerelease.length > 0 || !gte(version, min) || minors.has(`${major}.${minor}`)) {
      continue;
    }
    minors.add(`${major}.${minor}`);
    versions.push(version);
  }
  return versions;
}

function toDocsVersion(version: SemVer): DocsVersion {
  const label = `v${version.version}`;

  return gte(version, FIRST_DOCS_SUBDOMAIN)
    ? { label, url: `https://docs.${label}.archive.immich.app` }
    : { label, url: `https://${label}.archive.immich.app`, rootPath: '/docs' };
}
