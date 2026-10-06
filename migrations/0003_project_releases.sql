-- Releases of every project in projects.json, keyed by its permanent id. Only
-- tags the project's pattern and scheme accept are stored. Versions are ordered
-- in JS by the project's scheme, so there are no version columns to outgrow.
CREATE TABLE IF NOT EXISTS project_releases (
  project TEXT NOT NULL,
  tag TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT '',
  -- The forge's id for the release, such as GitHub's release id.
  source_id TEXT NOT NULL DEFAULT '',
  -- The forge's own prerelease flag (1 or 0), or NULL if it has none. Channels
  -- go by the tag, not by this.
  forge_prerelease INTEGER,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (project, tag)
) WITHOUT ROWID;

-- When each project last finished a full fetch from its source. A webhook write
-- never sets it: one release says nothing about the ones before it.
CREATE TABLE IF NOT EXISTS project_sync_state (
  project TEXT NOT NULL PRIMARY KEY,
  full_synced_at TEXT
);
