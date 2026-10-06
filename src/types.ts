export interface GitHubRelease {
  id: number;
  tag_name: string;
  published_at: string;
  prerelease: boolean;
}

// A row of project_releases, without its project and synced_at.
export interface ProjectRelease {
  tag: string;
  published_at: string;
  // The forge's id for the release, such as GitHub's release id.
  source_id: string;
  // The forge's own prerelease flag, or null if it has none. Channels go by the
  // tag (see normalize()), not by this.
  forge_prerelease: boolean | null;
}

// The newest release on one of a project's channels.
export interface LatestRelease {
  tag: string;
  // The tag pattern's version group, e.g. 3.3.0 for v3.3.0.
  version: string;
  published_at: string;
}

// The legacy /version body: `version` is the raw tag.
export interface VersionResponse {
  version: string;
  published_at: string;
}

// The /v1/projects/{id}/version body.
export interface ProjectVersionResponse {
  project: string;
  channel: string;
  // The tag pattern's version group, e.g. 3.3.0.
  version: string;
  // The raw tag, e.g. v3.3.0.
  tag: string;
  published_at: string;
}

export interface DocsVersion {
  label: string;
  url: string;
  rootPath?: string;
}
