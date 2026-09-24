export type TaskStatus =
  | 'draft'
  | 'waiting_auth'
  | 'queued'
  | 'cancelling'
  | 'failed'
  | 'needs_attention'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'cancelled';
export type Task = {
  id: string;
  title: string;
  prompt: string;
  model: string | null;
  project_id: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  demo?: boolean;
};
export type ModelOption = {
  model: string;
  displayName: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
};
export type Project = {
  github_repo?: string | null;
  id: string;
  name: string;
  description: string;
  created_at: string;
};
export type TaskEvent = {
  id: string;
  task_id: string;
  kind: string;
  content: string;
  created_at: string;
};
export const statuses: Record<TaskStatus, string> = {
  draft: '草稿',
  waiting_auth: '等待连接',
  queued: '排队中',
  cancelling: '正在停止',
  failed: '执行失败',
  needs_attention: '已中断',
  running: '运行中',
  waiting_approval: '等待审批',
  completed: '已完成',
  cancelled: '已停止',
};
export type Connection = {
  status: 'disconnected' | 'connecting' | 'pending' | 'connected' | 'error';
  email?: string;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
};
export type TaskDetail = {
  task: Task;
  events: TaskEvent[];
};
