export interface GitHubRelease {
  id: number;
  tag_name: string;
  published_at: string;
}

export interface VersionResponse {
  version: string;
  published_at: string;
}

export interface DocsVersion {
  label: string;
  url: string;
  rootPath?: string;
}
