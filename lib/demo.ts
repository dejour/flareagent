import type { Task, TaskEvent, Project } from './types';
export const demoProjects: Project[] = [
  {
    id: 'demo-product',
    name: '产品研发',
    description: '从需求、技术方案到可以交付的产品。',
    created_at: '2026-09-10T08:00:00Z',
  },
  {
    id: 'demo-research',
    name: '研究与洞察',
    description: '收集资料、比较方案，保留每一个结论的来源。',
    created_at: '2026-09-10T08:00:00Z',
  },
];
export const demoTasks: Task[] = [
  {
    id: 'demo-architecture',
    title: '梳理云 Agent 的技术架构',
    prompt:
      '对比现有 Agent 的实现，整理一份基于 Cloudflare 的云 Agent 架构方案，说明任务恢复、存储和认证的边界。',
    model: 'gpt-5.6-terra',
    project_id: 'demo-product',
    status: 'completed',
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:18:00Z',
    demo: true,
  },
  {
    id: 'demo-research-task',
    title: '整理开源 Agent 的实现思路',
    prompt: '研究 Maka、LobeHub 与 Memoh，把可借鉴的实现整理成对比表。',
    model: 'gpt-5.6-terra',
    project_id: 'demo-research',
    status: 'completed',
    created_at: '2026-09-10T07:00:00Z',
    updated_at: '2026-09-10T07:12:00Z',
    demo: true,
  },
];
export function demoEvents(task: Task): TaskEvent[] {
  return [
    {
      id: '1',
      task_id: task.id,
      kind: 'user',
      content: task.prompt,
      created_at: task.created_at,
    },
    {
      id: '2',
      task_id: task.id,
      kind: 'system',
      content: '已确定研究范围：运行时、任务恢复、工作区与模型认证。',
      created_at: task.created_at,
    },
    {
      id: '3',
      task_id: task.id,
      kind: 'tool',
      content: '阅读项目架构文档与 Cloudflare 官方资料',
      created_at: task.created_at,
    },
    {
      id: '4',
      task_id: task.id,
      kind: 'assistant',
      content:
        '建议将产品控制层与实际执行分开：Durable Objects 管理任务身份和事件，Workflows 管理调度，Sandbox 运行 Codex。工作区和会话检查点保存至 R2。\n\n恢复前核对执行记录与工作区版本；工具结果未知时先核实外部状态，避免重复操作。',
      created_at: task.updated_at,
    },
  ];
}
