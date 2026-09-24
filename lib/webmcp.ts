export type ModelContext = {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): unknown | Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
};
export function installWorkspaceTools(actions: {
  list: () => Promise<unknown>;
  prepare: (prompt: string) => void;
}) {
  const context = (document as Document & { modelContext?: ModelContext })
    .modelContext;
  if (!context?.registerTool) return;
  const controller = new AbortController();
  const tools = [
    {
      name: 'list_cloudagent_tasks',
      title: '查看我的云端任务',
      description: '读取当前登录用户保存的真实任务，不包含界面示例。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input: unknown) => {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          throw new Error('Expected an empty object');
        return actions.list();
      },
    },
    {
      name: 'prepare_cloudagent_task',
      title: '填写任务草稿',
      description:
        '在工作台输入框中填写任务要求。只准备草稿，不保存、不启动执行；用户仍需点击创建任务。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: unknown) => {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some((k) => k !== 'prompt') ||
          !('prompt' in input) ||
          typeof input.prompt !== 'string' ||
          !input.prompt.trim() ||
          input.prompt.trim().length > 20000
        )
          throw new Error(
            'A nonempty prompt of at most 20000 characters is required',
          );
        actions.prepare(input.prompt.trim());
        return { prepared: true, saved: false };
      },
    },
  ];
  for (const tool of tools) {
    try {
      Promise.resolve(
        context.registerTool(tool, { signal: controller.signal }),
      ).catch(() => console.warn('Workspace tool registration unavailable'));
    } catch {
      console.warn('Workspace tool registration unavailable');
    }
  }
  return () => controller.abort();
}
