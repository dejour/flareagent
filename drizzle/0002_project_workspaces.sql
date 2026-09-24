ALTER TABLE tasks ADD COLUMN workspace_id TEXT;
ALTER TABLE tasks ADD COLUMN checkpoint_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN github_repo TEXT;
ALTER TABLE projects ADD COLUMN github_repo_id INTEGER;
ALTER TABLE projects ADD COLUMN github_installation_id INTEGER;
CREATE UNIQUE INDEX projects_owner_repo ON projects(owner_id, github_repo_id) WHERE github_repo_id IS NOT NULL;
