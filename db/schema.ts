import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    githubRepo: text('github_repo'),
    githubRepoId: integer('github_repo_id'),
    githubInstallationId: integer('github_installation_id'),
    description: text('description').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('projects_owner').on(table.ownerId)],
);
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    requestId: text('request_id').notNull(),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    model: text('model'),
    projectId: text('project_id').references(() => projects.id),
    status: text('status').notNull().default('waiting_auth'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    runId: text('run_id'),
    threadId: text('thread_id'),
    checkpointKey: text('checkpoint_key'),
    workspaceId: text('workspace_id'),
    checkpointVersion: integer('checkpoint_version').notNull().default(1),
    checkpointMessageCount: integer('checkpoint_message_count')
      .notNull()
      .default(0),
  },
  (table) => [
    index('tasks_owner_updated').on(table.ownerId, table.updatedAt),
    uniqueIndex('tasks_owner_request').on(table.ownerId, table.requestId),
  ],
);
export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('events_task_created').on(table.taskId, table.createdAt)],
);
