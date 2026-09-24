ALTER TABLE tasks ADD COLUMN run_id TEXT;
ALTER TABLE tasks ADD COLUMN thread_id TEXT;
ALTER TABLE tasks ADD COLUMN checkpoint_key TEXT;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_task ON artifacts(task_id, created_at);
