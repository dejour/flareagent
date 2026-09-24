'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  ArrowUp,
  ArrowUpRight,
  ArrowLeft,
  Plus,
  Cloud,
  LayoutDashboard,
  Folder,
  Settings,
  Search,
  ChevronDown,
  ChevronRight,
  Terminal,
  X,
  Menu,
  Bot,
  ShieldCheck,
  Link2,
  Square,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { demoTasks, demoProjects, demoEvents } from '@/lib/demo';
import { installWorkspaceTools } from '@/lib/webmcp';
import {
  statuses,
  type Task,
  type Project,
  type TaskEvent,
  type Connection,
  type TaskDetail,
  type ModelOption,
} from '@/lib/types';

type View = 'home' | 'projects' | 'settings' | 'task';
type FeedItem =
  | { kind: 'message'; event: TaskEvent }
  | { kind: 'activity'; events: TaskEvent[] };

function groupEvents(events: TaskEvent[]): FeedItem[] {
  const feed: FeedItem[] = [];
  for (const event of events) {
    if (event.kind === 'user' || event.kind === 'assistant') {
      feed.push({ kind: 'message', event });
    } else {
      const last = feed[feed.length - 1];
      if (last?.kind === 'activity') last.events.push(event);
      else feed.push({ kind: 'activity', events: [event] });
    }
  }
  return feed;
}

export function Workspace({
  user,
}: {
  user: { name: string; email: string } | null;
}) {
  const [view, setView] = useState<View>('home');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [connection, setConnection] = useState<Connection>({
    status: 'disconnected',
  });
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!user);
  const [error, setError] = useState('');
  const [mobile, setMobile] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [github, setGithub] = useState<{
    configured: boolean;
    connected: boolean;
    login?: string;
    installUrl?: string;
  }>({ configured: false, connected: false });
  const [repos, setRepos] = useState<
    { id: number; full_name: string; installation_id: number }[]
  >([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoId, setRepoId] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const taskRequest = useRef(0);
  const pendingCreation = useRef<{
    prompt: string;
    projectId: string;
    model: string;
    requestId: string;
  } | null>(null);
  const [examples, setExamples] = useState(!user);
  async function api<T = Record<string, unknown>>(
    path: string,
    method = 'GET',
    body?: unknown,
  ) {
    const res = await fetch('/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result: unknown = await res.json();
    if (!res.ok)
      throw new Error(
        result && typeof result === 'object' && 'error' in result
          ? String(result.error)
          : '请求失败，请重试',
      );
    return result as T;
  }
  function applyDetail(d: TaskDetail) {
    setSelected(d.task);
    setEvents(d.events);
  }
  async function refresh() {
    if (!user) return;
    try {
      const data = await api<{ tasks: Task[]; projects: Project[] }>(
        'workspace',
      );
      setTasks(data.tasks);
      setProjects(data.projects);
      setGithub(await api('connections/github'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return installWorkspaceTools({
      list: async () => {
        const d = await api<{ tasks: Task[] }>('workspace');
        return {
          tasks: d.tasks.map(({ id, title, status }) => ({
            id,
            title,
            status,
          })),
        };
      },
      prepare: (value) => {
        nav('home');
        setPrompt(value);
      },
    });
  }, []);
  useEffect(() => {
    const onHash = () => {
      const hash = location.hash.slice(1);
      if (['home', 'projects', 'settings'].includes(hash)) {
        taskRequest.current++;
        setView(hash as View);
        setSelected(null);
      } else if (hash.startsWith('task/')) {
        const id = hash.slice(5);
        const demo = demoTasks.find((t) => t.id === id);
        if (demo) {
          void openTask(demo);
        } else if (/^[a-zA-Z0-9-]+$/.test(id)) {
          const version = ++taskRequest.current;
          void api<TaskDetail>('tasks/' + id)
            .then((d) => {
              if (version !== taskRequest.current) return;
              setView('task');
              applyDetail(d);
            })
            .catch((e) => setError((e as Error).message));
        }
      }
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function poll() {
      try {
        const state = await api<Connection>('connections/openai');
        if (!cancelled) setConnection(state);
        if (selected && !selected.demo) {
          const detail = await api<TaskDetail>('tasks/' + selected.id);
          if (!cancelled) applyDetail(detail);
        }
        const workspace = await api<{ tasks: Task[]; projects: Project[] }>(
          'workspace',
        );
        if (!cancelled) {
          setTasks(workspace.tasks);
          setProjects(workspace.projects);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) timer = setTimeout(poll, 4000);
    }
    let timer: ReturnType<typeof setTimeout>;
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [user, selected?.id]);
  useEffect(() => {
    if (!user || !selected || selected.demo) return;
    let closed = false;
    const source = new EventSource(
      `/api/tasks/${encodeURIComponent(selected.id)}/stream`,
    );
    source.addEventListener('update', () => {
      void api<TaskDetail>('tasks/' + selected.id)
        .then((detail) => {
          if (!closed) applyDetail(detail);
        })
        .catch(() => {});
    });
    return () => {
      closed = true;
      source.close();
    };
  }, [user, selected?.id]);
  useEffect(() => {
    if (!user || connection.status !== 'connected') {
      setModels([]);
      return;
    }
    let cancelled = false;
    void api<{ models: ModelOption[] }>('connections/openai/models')
      .then((result) => {
        if (!cancelled) setModels(result.models);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [user, connection.status]);
  async function connect(method = 'POST') {
    setBusy(true);
    setError('');
    try {
      setConnection(await api<Connection>('connections/openai', method, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function nav(next: View) {
    taskRequest.current++;
    setView(next);
    setMobile(false);
    setError('');
    if (next !== 'task') {
      setSelected(null);
      location.hash = next;
    }
  }
  async function openTask(task: Task) {
    setSelected(task);
    setPrompt('');
    nav('task');
    history.replaceState(null, '', '#task/' + task.id);
    const version = taskRequest.current;
    setEvents([]);
    if (task.demo) {
      setEvents(demoEvents(task));
      return;
    }
    try {
      const d = await api<TaskDetail>('tasks/' + task.id);
      if (version === taskRequest.current) applyDetail(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function createTask() {
    if (!prompt.trim() || busy) return;
    if (!user) {
      setError('登录工作台后即可保存任务。模型账号需要在设置中单独连接。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (
        !pendingCreation.current ||
        pendingCreation.current.prompt !== prompt.trim() ||
        pendingCreation.current.projectId !== projectId ||
        pendingCreation.current.model !== model
      ) {
        pendingCreation.current = {
          prompt: prompt.trim(),
          projectId,
          model,
          requestId: crypto.randomUUID(),
        };
      }
      const d = await api<{ task: Task }>('tasks', 'POST', {
        ...pendingCreation.current,
        projectId: projectId || null,
      });
      pendingCreation.current = null;
      setExamples(false);
      setPrompt('');
      await refresh();
      await openTask(d.task);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function taskAction(action: string) {
    if (!selected || selected.demo || busy) return;
    setBusy(true);
    try {
      await api('tasks/' + selected.id, 'PATCH', {
        action,
      });
      await refresh();
      await openTask(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sendMessage() {
    if (!selected || selected.demo || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      await api('tasks/' + selected.id + '/events', 'POST', {
        content: prompt.trim(),
      });
      setPrompt('');
      await api('tasks/' + selected.id, 'PATCH', { action: 'resume' });
      await openTask(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function githubAction(disconnect = false) {
    setBusy(true);
    setError('');
    try {
      if (disconnect) {
        await api('connections/github', 'DELETE', {});
        setRepos([]);
        setGithub(await api('connections/github'));
      } else {
        const result = await api<{ url: string }>(
          'connections/github',
          'POST',
          {},
        );
        window.location.assign(result.url);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadRepos() {
    setReposLoading(true);
    setError('');
    try {
      const result = await api<{ repositories: typeof repos }>(
        'connections/github/repos',
      );
      setRepos(result.repositories);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReposLoading(false);
    }
  }
  async function createProject() {
    if (!projectName.trim() || busy) return;
    setBusy(true);
    try {
      await api('projects', 'POST', {
        name: projectName.trim(),
        description: projectDescription.trim(),
        repoId: repoId ? Number(repoId) : undefined,
        installationId: repos.find((r) => String(r.id) === repoId)
          ?.installation_id,
      });
      await refresh();
      setProjectDialog(false);
      setProjectName('');
      setProjectDescription('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openProjectDialog() {
    if (!user) {
      setError('请先登录，再连接仓库。');
      return;
    }
    setProjectDialog(true);
    if (github.connected) void loadRepos();
  }
  const allTasks = examples ? demoTasks : tasks;
  const allProjects = examples ? demoProjects : projects;
  const visible = allTasks.filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'attention'
          ? ['waiting_auth', 'waiting_approval', 'needs_attention'].includes(
              t.status,
            )
          : t.status === filter)) &&
      t.title.toLowerCase().includes(search.toLowerCase()),
  );
  const currentProject = (selected?.demo ? demoProjects : projects).find(
    (p) => p.id === selected?.project_id,
  );
  const promptBox = (detail = false) => (
    <div className="composer">
      <textarea
        aria-label={detail ? '补充任务指令' : '描述新任务'}
        placeholder={
          detail
            ? '补充背景、调整要求，或告诉 Agent 下一步做什么…'
            : '描述你想完成的工作，例如：修复登录错误并创建 PR…'
        }
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void (detail ? sendMessage() : createTask());
          }
        }}
        disabled={!!(detail && selected?.demo)}
      />
      <div className="composer-bottom">
        <div className="composer-options">
          {detail ? (
            <span>
              <Bot size={15} />
              {selected?.model || 'Codex 默认模型'}
            </span>
          ) : (
            <label className="model-picker">
              <Bot size={15} />
              <select
                aria-label="模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={connection.status !== 'connected'}
              >
                <option value="">
                  {connection.status === 'connected'
                    ? `自动选择${models.find((item) => item.isDefault)?.displayName ? ` · ${models.find((item) => item.isDefault)?.displayName}` : ''}`
                    : '连接后选择模型'}
                </option>
                {models.map((item) => (
                  <option key={item.model} value={item.model}>
                    {item.displayName}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
          )}
          {!detail && (
            <label className="project-picker">
              <Folder size={15} />
              <select
                aria-label="工作仓库或项目"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">不关联仓库</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.github_repo || p.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
          )}
          {!detail && (
            <button className="composer-link" onClick={openProjectDialog}>
              <Plus size={13} /> 连接仓库
            </button>
          )}
        </div>
        <Button
          className="send"
          aria-label={detail ? '发送补充指令' : '创建任务'}
          disabled={!prompt.trim() || busy || !!(detail && selected?.demo)}
          onClick={() => void (detail ? sendMessage() : createTask())}
        >
          {detail ? '发送' : '开始任务'} <ArrowUp size={16} />
        </Button>
      </div>
    </div>
  );
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="scrim"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={'sidebar ' + (mobile ? 'is-open' : '')}>
        <a href="#home" className="brand" onClick={() => nav('home')}>
          <span className="brand-icon">
            <Cloud size={23} />
          </span>{' '}
          flareagent<span className="brand-dot">.</span>
        </a>
        <Button
          variant="outline"
          className="new-task"
          onClick={() => {
            nav('home');
            setPrompt('');
            setTimeout(() => document.querySelector('textarea')?.focus(), 0);
          }}
        >
          <Plus size={17} /> 新建任务
        </Button>
        <nav aria-label="主导航">
          {[
            { id: 'home', icon: LayoutDashboard, label: '工作台' },
            { id: 'projects', icon: Folder, label: '项目空间' },
            { id: 'settings', icon: Settings, label: '设置' },
          ].map((n) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              onClick={() => nav(n.id as View)}
            >
              <n.icon size={18} />
              {n.label}
              {n.id === 'home' && (
                <span className="nav-count">{tasks.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <span>最近任务</span>
          <span>{examples ? '示例' : ''}</span>
        </div>
        <div className="recent-tasks">
          {allTasks.slice(0, 5).map((t) => (
            <button key={t.id} onClick={() => void openTask(t)}>
              <span className={'tiny-dot ' + t.status} />
              <span>{t.title}</span>
            </button>
          ))}
          {!allTasks.length && <p>你的下一项工作，从这里开始。</p>}
        </div>
        <div className="sidebar-bottom">
          <button className="profile" onClick={() => nav('settings')}>
            <span className="profile-avatar">
              {user ? user.name.slice(0, 1).toUpperCase() : '访'}
            </span>
            <span>
              {user ? user.name : '访客预览'}
              <small>{user ? '个人工作空间' : '登录后保存你的工作'}</small>
            </span>
            <Settings size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              aria-label="打开导航"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <strong>
              {view === 'home'
                ? '工作台'
                : view === 'projects'
                  ? '项目空间'
                  : view === 'settings'
                    ? '设置'
                    : selected?.title || '任务'}
            </strong>
          </div>
          <div className="topbar-right">
            {!user && (
              <a className="login-link" href="/login" target="_top">
                登录工作台 <ArrowUpRight size={14} />
              </a>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            <AlertCircle size={17} />
            <span>{error}</span>
            <button aria-label="关闭提示" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {view === 'home' && (
          <main className="dashboard agent-home">
            <div className="page-heading agent-heading">
              <div>
                <h1>交给 Agent，继续你的工作</h1>
                <p>选择仓库和模型，描述目标。每个任务使用独立的云端工作空间。</p>
              </div>
              <span
                className={
                  'connection-pill ' +
                  (connection.status === 'connected' ? 'is-ready' : '')
                }
              >
                <span className="tiny-dot" />
                {connection.status === 'connected'
                  ? 'Codex 已就绪'
                  : '需要连接 Codex'}
              </span>
            </div>
            {promptBox()}
            <section className="task-section">
              <div className="section-heading task-list-heading">
                <div>
                  <h2>最近任务</h2>
                  <span>{allTasks.length}</span>
                </div>
                <button
                  className="text-button"
                  onClick={() => setExamples(!examples)}
                >
                  {examples ? '隐藏示例' : '查看示例'}
                </button>
              </div>
              <div className="list-toolbar">
                <div className="tabs">
                  {[
                    ['all', '全部'],
                    ['running', '运行中'],
                    ['attention', '需要处理'],
                    ['completed', '已完成'],
                  ].map(([v, l]) => (
                    <button
                      className={filter === v ? 'active' : ''}
                      key={v}
                      onClick={() => setFilter(v)}
                    >
                      {l}
                      <span>
                        {v === 'all'
                          ? allTasks.length
                          : v === 'attention'
                            ? allTasks.filter((t) =>
                                [
                                  'waiting_auth',
                                  'waiting_approval',
                                  'needs_attention',
                                ].includes(t.status),
                              ).length
                            : allTasks.filter((t) => t.status === v).length}
                      </span>
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={15} />
                  <input
                    aria-label="搜索任务"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索任务"
                  />
                </label>
              </div>
              {examples && (
                <div className="example-note">
                  示例工作空间 ·
                  以下内容用于展示任务与对话的组织方式，不是真实执行记录。
                </div>
              )}
              <div className="task-table">
                {loading && !examples ? (
                  <div className="empty-state">正在加载工作空间…</div>
                ) : visible.length ? (
                  visible.map((t) => (
                    <button
                      className="task-row"
                      key={t.id}
                      onClick={() => void openTask(t)}
                    >
                      <span className="task-name">
                        <span className="task-glyph">
                          <Terminal size={18} />
                        </span>
                        <span>
                          {t.title}
                          <small>
                            {allProjects.find((p) => p.id === t.project_id)?.github_repo ||
                              allProjects.find((p) => p.id === t.project_id)?.name ||
                              '独立任务'}
                            {' · '}
                            {new Date(t.updated_at).toLocaleDateString('zh-CN', {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </small>
                        </span>
                      </span>
                      <span>
                        <span className={'status ' + t.status}>
                          <span className="tiny-dot" />
                          {statuses[t.status]}
                        </span>
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <span className="empty-icon">
                      <Cloud size={30} />
                    </span>
                    <h3>
                      {search || filter !== 'all'
                        ? '没有符合条件的任务'
                        : '准备好开始下一件事了吗？'}
                    </h3>
                    <p>
                      {search || filter !== 'all'
                        ? '试试其他关键词或筛选条件。'
                        : '在上方描述目标。任务对话和执行记录将在这里保存。'}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </main>
        )}
        {view === 'projects' && (
          <main className="dashboard">
            <div className="section-heading page-title">
              <div>
                <div className="eyebrow">PROJECTS</div>
                <h1>项目空间</h1>
                <p>把背景、目标和相关任务放在一起。</p>
              </div>
              <Button className="primary-button" onClick={openProjectDialog}>
                <Plus size={16} />
                新建项目
              </Button>
            </div>
            <div className="project-grid">
              {projects.map((p) => (
                <article className="project-card" key={p.id}>
                  {p.github_repo && (
                    <p className="fine-print">{p.github_repo}</p>
                  )}
                  <Folder size={26} />
                  <h2>{p.name}</h2>
                  <p>{p.description || '还没有项目说明。'}</p>
                  <div>
                    <span>
                      {tasks.filter((t) => t.project_id === p.id).length} 个任务
                    </span>
                    <button
                      className="text-button"
                      onClick={() => {
                        setProjectId(p.id);
                        nav('home');
                      }}
                    >
                      创建任务
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {tasks
                    .filter((t) => t.project_id === p.id)
                    .map((t) => (
                      <button
                        className="project-task"
                        key={t.id}
                        onClick={() => void openTask(t)}
                      >
                        {t.title}
                        <ChevronRight size={14} />
                      </button>
                    ))}
                </article>
              ))}
            </div>
            {!projects.length && (
              <div className="empty-state bordered">
                <Folder size={32} />
                <h3>给长期工作一个空间</h3>
                <p>创建项目，保存背景说明，并关联后续任务。</p>
              </div>
            )}
          </main>
        )}
        {view === 'settings' && (
          <main className="dashboard settings-page">
            <div className="page-title">
              <h1>设置</h1>
              <p>管理 Codex、GitHub 和工作台账号。</p>
            </div>
            <section className="settings-card">
              <div className="settings-icon">
                <Bot size={25} />
              </div>
              <div className="settings-body">
                <div className="section-heading">
                  <h2>ChatGPT / Codex</h2>
                  <span className={'status ' + (connection.status === 'connected' ? 'completed' : 'waiting_auth')}>
                    <span className="tiny-dot" />
                    {connection.status === 'connected' ? '已连接' : '未连接'}
                  </span>
                </div>
                <p>{connection.status === 'connected' ? connection.email || 'Codex 可以开始执行任务。' : '连接你的 ChatGPT 账号以运行 Codex。'}</p>
                {(connection.status === 'pending' || connection.status === 'connecting' || connection.error) && <div className="setup-note">
                  <Link2 size={18} />
                  <div>
                    <strong>
                      {connection.status === 'connected'
                        ? '账号已连接'
                        : connection.status === 'connecting'
                          ? '正在启动授权服务…'
                          : connection.status === 'pending'
                            ? '在 OpenAI 完成设备授权'
                            : '连接你的 ChatGPT 账号'}
                    </strong>
                    <p>{connection.error || (connection.status === 'pending' ? '复制设备码并在 OpenAI 完成授权。' : '正在准备连接…')}</p>
                    {connection.status === 'pending' && connection.userCode && (
                      <div className="device-code">
                        <code>{connection.userCode}</code>
                        <button
                          className="text-button"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(connection.userCode!)
                              .catch(() =>
                                setError('复制失败，请手动复制设备码。'),
                              );
                          }}
                        >
                          复制设备码
                        </button>
                      </div>
                    )}
                    {connection.status === 'pending' &&
                      connection.verificationUrl?.startsWith(
                        'https://auth.openai.com/',
                      ) && (
                        <a
                          className="primary-button"
                          href={connection.verificationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          前往 OpenAI 授权 <ExternalLink size={14} />
                        </a>
                      )}
                  </div>
                </div>}
                <button
                  className="secondary-button"
                  onClick={() =>
                    void connect(
                      connection.status === 'connected' ? 'DELETE' : 'POST',
                    )
                  }
                  disabled={
                    busy ||
                    ['connecting', 'pending'].includes(connection.status)
                  }
                >
                  {connection.status === 'connected'
                    ? '断开模型账号'
                    : connection.status === 'connecting'
                      ? '正在连接…'
                      : connection.status === 'pending'
                        ? '等待授权完成…'
                        : '连接 ChatGPT'}
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </section>
            <section className="settings-card">
              <div className="settings-icon">
                <ShieldCheck size={24} />
              </div>
              <div className="settings-body">
                <h2>GitHub</h2>
                <p>
                  {github.connected
                    ? `已连接 ${github.login || ''}`
                    : '连接后可以选择 GitHub App 已授权的仓库。'}
                </p>
                {!github.configured && (
                  <p className="fine-print">
                    部署方尚未配置 GitHub App，配置完成后可在此授权。
                  </p>
                )}
                <button
                  className="secondary-button"
                  disabled={busy || !github.configured}
                  onClick={() => void githubAction(github.connected)}
                >
                  {github.connected ? '断开 GitHub' : '连接 GitHub'}
                </button>
                {github.installUrl && (
                  <a
                    className="text-button"
                    href={github.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    安装 App / 管理仓库权限
                  </a>
                )}
              </div>
            </section>
            <section className="settings-card account-card">
              <div className="settings-icon"><Settings size={22} /></div>
              <div className="settings-body">
                <h2>工作空间账号</h2>
                <p>
                  {user
                    ? user.email
                    : '登录后，项目和任务会保存到你的个人工作空间。'}
                </p>
                {user ? (
                  <a className="secondary-button" href="/logout" target="_top">
                    退出工作台
                  </a>
                ) : (
                  <a className="primary-button" href="/login" target="_top">
                    登录工作台
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            </section>
          </main>
        )}
        {view === 'task' && selected && (
          <main className="task-detail">
            <section className="conversation">
              <div className="task-detail-heading">
                <button className="text-button" onClick={() => nav('home')}>
                  <ArrowLeft size={15} />
                  全部任务
                </button>
                <div>
                  <span className={'status ' + selected.status}>
                    <span className="tiny-dot" />
                    {statuses[selected.status]}
                  </span>
                  {!selected.demo &&
                    [
                      'queued',
                      'running',
                      'waiting_approval',
                      'waiting_auth',
                    ].includes(selected.status) && (
                      <Button
                        variant="outline"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void taskAction('cancel')}
                      >
                        <Square size={12} />
                        停止
                      </Button>
                    )}
                  {!selected.demo &&
                    [
                      'cancelled',
                      'failed',
                      'waiting_auth',
                    ].includes(selected.status) && (
                      <Button
                        variant="outline"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void taskAction('resume')}
                      >
                        启动任务
                      </Button>
                    )}
                </div>
              </div>
              <h1>{selected.title}</h1>
              <div className="task-meta">
                <Bot size={14} /> {selected.model || 'Codex 默认模型'}{' '}
                <span>·</span>
                {currentProject?.github_repo || currentProject?.name || '独立任务'}
                {selected.demo && (
                  <span className="example-pill">示例 · 只读</span>
                )}
              </div>
              <div className="event-feed">
                {groupEvents(events).map((item) =>
                  item.kind === 'message' ? (
                    <article
                      key={item.event.id}
                      className={'event ' + item.event.kind}
                    >
                      <div className="event-icon">
                        {item.event.kind === 'user' ? <span>你</span> : <Bot size={15} />}
                      </div>
                      <div>
                        <div className="event-label">
                          {item.event.kind === 'user' ? '你' : 'FlareAgent'}
                          <time>
                            {new Date(item.event.created_at).toLocaleTimeString('zh-CN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                        <p>{item.event.content}</p>
                      </div>
                    </article>
                  ) : (
                    <details key={item.events[0].id} className="event-activity">
                      <summary>
                        <ChevronRight size={14} />
                        执行过程 · {item.events.length} 条记录
                      </summary>
                      <div className="event-activity-list">
                        {item.events.map((e) => (
                          <div key={e.id} className="event-activity-entry">
                            <span>{e.kind === 'tool' ? '工具' : '状态'}</span>
                            <p>{e.content}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  ),
                )}
              </div>
              {selected.status === 'waiting_auth' && (
                <div className="waiting-card">
                  <AlertCircle size={20} />
                  <div>
                    <strong>任务已保存，等待模型连接</strong>
                    <p>连接 ChatGPT 后，点击“启动任务”开始执行。</p>
                    <button
                      className="text-button"
                      onClick={() => nav('settings')}
                    >
                      前往连接设置
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              )}
              <div className="detail-composer">
                {selected.demo ? (
                  <p className="fine-print">
                    这是只读示例。返回工作台，创建属于你的任务。
                  </p>
                ) : [
                    'running',
                    'queued',
                    'waiting_approval',
                    'cancelling',
                  ].includes(selected.status) ? (
                  <p className="fine-print">
                    任务正在执行，进度会自动更新。需要修改要求时，请先停止任务。
                  </p>
                ) : selected.status === 'cancelled' ? (
                  <p className="fine-print">
                    任务已停止。恢复后可继续补充要求。
                  </p>
                ) : (
                  promptBox(true)
                )}
              </div>
            </section>
          </main>
        )}
      </div>
      <Dialog open={projectDialog} onOpenChange={setProjectDialog}>
        <DialogContent className="modal managed-dialog" showCloseButton={false}>
          <div className="section-heading">
            <DialogTitle id="project-title">新建项目</DialogTitle>
            <button
              className="icon-button"
              aria-label="关闭"
              onClick={() => setProjectDialog(false)}
            >
              <X size={19} />
            </button>
          </div>
          <label>
            项目名称
            <input
              autoFocus
              value={projectName}
              maxLength={80}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="例如：产品研发"
            />
          </label>
          {github.connected ? (
            <>
              <label>
                GitHub 仓库（可选）
                <select
                  value={repoId}
                  onChange={(e) => setRepoId(e.target.value)}
                  disabled={reposLoading}
                >
                  <option value="">
                    {reposLoading
                      ? '正在加载仓库…'
                      : repos.length
                        ? '不关联仓库'
                        : '没有可用的仓库'}
                  </option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="text-button"
                disabled={reposLoading}
                onClick={() => void loadRepos()}
              >
                {reposLoading ? '正在加载…' : '刷新已授权仓库'}
              </button>
            </>
          ) : (
            <div className="setup-note">
              <Link2 size={18} />
              <div>
                <strong>先连接 GitHub</strong>
                <p>
                  连接当前 GitHub 账号后，这里会自动列出 GitHub App
                  已授权的仓库。
                </p>
                <button
                  className="secondary-button"
                  disabled={busy || !github.configured}
                  onClick={() => void githubAction()}
                >
                  连接 GitHub
                </button>
              </div>
            </div>
          )}
          <p className="fine-print">
            同一仓库的不同任务使用独立工作空间；重复选择仓库会复用项目配置。
          </p>
          <label>
            背景说明
            <textarea
              value={projectDescription}
              maxLength={4000}
              onChange={(e) => setProjectDescription(e.target.value)}
              placeholder="这个项目的目标和需要长期保留的背景…"
            />
          </label>
          {error && (
            <p role="alert" className="dialog-error">
              {error}
            </p>
          )}
          <button
            className="primary-button"
            disabled={!projectName.trim() || busy}
            onClick={() => void createProject()}
          >
            {busy ? '正在保存…' : '创建项目'}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
