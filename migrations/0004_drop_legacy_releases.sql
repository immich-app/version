-- The legacy releases table, which 0001 and 0002 created, is no longer read or
-- written: releases live in project_releases (0003). Those files are deleted with
-- this one, or every replay would recreate the table only for this to drop it.
DROP INDEX IF EXISTS idx_releases_semver;
DROP TABLE IF EXISTS releases;
