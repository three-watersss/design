import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Layers3,
  LayoutDashboard,
  Images,
  Send,
  Settings2,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Check,
  RefreshCw,
  Pause,
  Play,
  Upload,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Copy,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  AlertCircle,
  FolderOpen,
  FileSpreadsheet,
  Sparkles,
  SlidersHorizontal,
  ExternalLink,
  Trash2,
} from "lucide-react";
import "./style.css";
type ImageAsset = {
  id: string;
  url: string;
  width: number;
  height: number;
  position: number;
};
type Task = {
  id: string;
  account: string;
  topic: string;
  state: string;
  stage: string;
  version: number;
  images: ImageAsset[];
  title: string | null;
  body: string | null;
  error: string | null;
  progress: string;
  warning: string | null;
  created_at: number;
  queued_at: number;
  review_finished_at: number | null;
  published_at: number | null;
  next_at: number;
};
type State = {
  tasks: Task[];
  queue: {
    paused: boolean;
    blocked: string | null;
    cooldownUntil: number;
    running: number;
    concurrency: number;
  };
  checks: { name: string; ok: boolean; message: string }[];
  config: {
    model: string;
    effort: string;
    proxyHost: string;
  };
  counts: {
    running: number;
    queued: number;
    review: number;
    ready: number;
    published: number;
  };
};
const labels: Record<string, string> = {
  queued_images: "等待生图",
  running_images: "图片生成中",
  review_images: "图片待审核",
  queued_copy: "等待文案",
  running_copy: "文案生成中",
  review_copy: "文案待审核",
  ready: "未发布",
  published: "已发布",
  cleaning: "清理旧结果",
  failed: "生成异常",
  blocked: "等待恢复",
};
async function api(url: string, body?: unknown, method = "POST") {
  const r = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await r.json();
  if (!r.ok) throw Error(result.error ?? "请求失败");
  return result;
}
const time = (n: number) =>
  new Date(n).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
function Badge({ state }: { state: string }) {
  return (
    <span className={"badge " + state}>
      {state.startsWith("running") ? (
        <LoaderCircle size={12} className="spin" />
      ) : state.startsWith("review") ? (
        <span className="dot" />
      ) : null}
      {labels[state] ?? state}
    </span>
  );
}
function App() {
  const [data, setData] = useState<State | null>(null),
    [page, setPage] = useState("work"),
    [account, setAccount] = useState(""),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [showImport, setShowImport] = useState(false),
    [settings, setSettings] = useState(false),
    [deleteTarget, setDeleteTarget] = useState<Task | null>(null),
    [lightbox, setLightbox] = useState<{
      images: ImageAsset[];
      index: number;
    } | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null),
    [excluded, setExcluded] = useState<string[]>([]),
    [picked, setPicked] = useState(false);
  const load = async () => {
    try {
      setData(await api("/api/state"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const events = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout>;
    events.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    };
    events.onerror = () =>
      setError("连接暂时中断，正在自动重连；已保存的任务不会丢失。");
    events.onopen = () => setError("");
    return () => {
      events.close();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const changePage = (next: string) => {
    setPage(next);
    setFilter("all");
    setQuery("");
    setSelected(null);
  };
  const taskAction = (t: Task, kind: string) =>
    action(() => api(`/api/tasks/${t.id}/${kind}`, { version: t.version }));
  const copyText = async (t: Task) => {
    try {
      await navigator.clipboard.writeText(
        `${t.title ?? ""}\n\n${t.body ?? ""}`,
      );
      setNotice("文案已复制");
    } catch {
      setError("复制失败，请选中文案手动复制");
    }
  };
  const pick = async (reset = false) => {
    const omit = reset ? [] : excluded;
    await action(async () => {
      const result = await api("/api/publish/pick", {
        account,
        excluded: omit,
      });
      setCandidate(result.task?.id ?? null);
      setPicked(true);
      setExcluded(result.task ? [...omit, result.task.id] : omit);
    });
  };
  if (!data)
    return (
      <div className="loading">
        <div className="brandmark">
          <Layers3 />
        </div>
        <LoaderCircle className="spin" />
        正在打开素材工作台…{error && <p>{error}</p>}
      </div>
    );
  const accounts = [...new Set(data.tasks.map((t) => t.account))].sort();
  const matches = (t: Task) =>
    (!account || account === t.account) &&
    (!query ||
      `${t.account} ${t.topic}`.toLowerCase().includes(query.toLowerCase()));
  const tasks = data.tasks
    .filter(
      (t) =>
        matches(t) &&
        (page === "library"
          ? ["ready", "published"].includes(t.state)
          : !["ready", "published"].includes(t.state)),
    )
    .filter(
      (t) =>
        filter === "all" ||
        (filter === "review" && t.state.startsWith("review")) ||
        (filter === "running" && t.state.startsWith("running")) ||
        (filter === "queued" && t.state.startsWith("queued")) ||
        (filter === "error" && ["failed", "blocked"].includes(t.state)) ||
        filter === t.state,
    );
  const current = data.tasks.find(
    (t) => t.id === (page === "publish" ? candidate : selected),
  );
  const checkFailed = data.checks.some((c) => !c.ok),
    blocked = data.queue.blocked;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandmark">
            <Layers3 size={24} />
          </div>
          <div>
            拾光<span>素材工作台</span>
          </div>
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          <button
            className={page === "work" ? "active" : ""}
            onClick={() => changePage("work")}
          >
            <LayoutDashboard size={19} />
            生成工作台{data.counts.review > 0 && <b>{data.counts.review}</b>}
          </button>
          <button
            className={page === "library" ? "active" : ""}
            onClick={() => changePage("library")}
          >
            <Images size={19} />
            素材库<span>{data.counts.ready + data.counts.published}</span>
          </button>
          <button
            className={page === "publish" ? "active" : ""}
            onClick={() => changePage("publish")}
          >
            <Send size={19} />
            发布台
          </button>
        </nav>
        <div className="sidebar-note">
          <div className="note-icon">
            <Sparkles size={18} />
          </div>
          <strong>让创作，有条不紊</strong>
          <p>
            选题到成品，每一步都在这里。
            <br />
            把时间留给更好的灵感。
          </p>
          <button onClick={() => setShowImport(true)}>
            导入新选题 <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setSettings(true)}>
            <Settings2 size={18} />
            运行设置
          </button>
          <div className="profile">
            <div className="avatar">M</div>
            <div>
              <strong>我的工作空间</strong>
              <span>
                <i />
                本地保存 · 仅自己可见
              </span>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            工作空间 <ChevronRight size={14} />{" "}
            <strong>
              {page === "work"
                ? "生成工作台"
                : page === "library"
                  ? "素材库"
                  : "发布台"}
            </strong>
          </div>
          <button className="connection" onClick={() => setSettings(true)}>
            <i className={checkFailed ? "bad" : ""} />
            {checkFailed
              ? "运行环境待检查"
              : data.checks.length
                ? "订阅连接已就绪"
                : "正在检查环境"}
            <ExternalLink size={12} />
          </button>
        </header>
        <main>
          <div className="page-head">
            <div className="page-heading">
              <span className="eyebrow">
                {page === "work"
                  ? "CREATE & CURATE"
                  : page === "library"
                    ? "YOUR COLLECTION"
                    : "READY TO SHARE"}
              </span>
              <h1>
                {page === "work"
                  ? "让选题，变成好内容。"
                  : page === "library"
                    ? "每一份成品，都有归处。"
                    : "挑一份灵感，准备发布。"}
              </h1>
              <p>
                {page === "work"
                  ? "从图片到文案，自动生成，由你把关。"
                  : page === "library"
                    ? "保存已通过的图片与文案，随时找到下一篇笔记。"
                    : "从未发布的完整素材中挑选，复制、下载，再标记发布。"}
              </p>
            </div>
            <button className="primary" onClick={() => setShowImport(true)}>
              <Plus size={17} />
              导入选题
            </button>
          </div>
          {error && (
            <div className="alert error">
              <AlertCircle size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {(checkFailed || blocked) && (
            <div className="alert">
              <AlertCircle size={17} />
              <span>
                {blocked ??
                  "环境检查未通过，生成队列暂不派发。已有素材仍可查看。"}
              </span>
              <button onClick={() => setSettings(true)}>
                查看详情 <ArrowRight size={14} />
              </button>
            </div>
          )}
          {data.queue.cooldownUntil > Date.now() && (
            <div className="alert">
              <Clock3 size={17} />
              <span>
                账号请求受限，暂停派发至 {time(data.queue.cooldownUntil)}
                。到时自动重试。
              </span>
            </div>
          )}
          <div className="stats">
            <Stat
              icon={<LoaderCircle size={19} />}
              title="正在生成"
              value={data.counts.running}
              detail={`最多同时 ${data.queue.concurrency} 个`}
              color="purple"
            />
            <Stat
              icon={<Clock3 size={19} />}
              title="排队中"
              value={data.counts.queued}
              detail="按顺序自动推进"
              color="blue"
            />
            <Stat
              icon={<CheckCircle2 size={19} />}
              title="等待审核"
              value={data.counts.review}
              detail="等待你的好眼光"
              color="orange"
            />
            <Stat
              icon={<FolderOpen size={19} />}
              title="待发布素材"
              value={data.counts.ready}
              detail="已准备好，随时出发"
              color="green"
            />
          </div>
          <div className="toolbar">
            <div className="section-title">
              {page === "work"
                ? "生成任务"
                : page === "library"
                  ? "我的素材"
                  : "发布候选"}
              <span>
                {page === "publish" ? data.counts.ready : tasks.length}
              </span>
            </div>
            <div className="tools">
              <select
                aria-label="筛选账号"
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setCandidate(null);
                  setExcluded([]);
                  setPicked(false);
                }}
              >
                <option value="">全部账号</option>
                {accounts.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
              {page !== "publish" && (
                <div className="search">
                  <Search size={15} />
                  <input
                    placeholder="搜索账号或主题"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              )}
              {page === "work" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      api("/api/queue", {
                        paused: !(data.queue.paused || blocked || checkFailed),
                      }),
                    )
                  }
                >
                  {data.queue.paused || blocked || checkFailed ? (
                    <Play size={14} />
                  ) : (
                    <Pause size={14} />
                  )}{" "}
                  {data.queue.paused || blocked || checkFailed
                    ? "恢复队列"
                    : "暂停派发"}
                </button>
              )}
            </div>
          </div>
          {page !== "publish" && (
            <div className="tabs">
              {(page === "work"
                ? [
                    ["all", "全部任务"],
                    ["review", "待审核"],
                    ["running", "生成中"],
                    ["queued", "排队中"],
                    ["error", "异常"],
                  ]
                : [
                    ["all", "全部素材"],
                    ["ready", "未发布"],
                    ["published", "已发布"],
                  ]
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={filter === key ? "active" : ""}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
              {data.queue.paused && page === "work" && (
                <span className="muted">
                  <Pause size={12} />
                  已暂停新任务派发，正在执行的任务继续完成
                </span>
              )}
            </div>
          )}
          {page === "work" &&
            (tasks.length ? (
              <div className="work-grid">
                <div className="task-list">
                  {tasks.map((t) => (
                    <button
                      key={t.id}
                      className={
                        "task-card " + (selected === t.id ? "selected" : "")
                      }
                      onClick={() => setSelected(t.id)}
                    >
                      <div className="task-top">
                        <span className="account-icon">
                          {t.account.slice(0, 1)}
                        </span>
                        <span>{t.account}</span>
                        <Badge state={t.state} />
                      </div>
                      <h3>{t.topic}</h3>
                      <div className="task-bottom">
                        <span
                          title={
                            t.review_finished_at != null
                              ? "本次生成完成时间"
                              : t.state.startsWith("running")
                                ? "本轮提交生成时间"
                                : "选题创建时间"
                          }
                        >
                          {t.review_finished_at != null
                            ? `生成于 ${time(t.review_finished_at)}`
                            : t.state.startsWith("running")
                              ? `提交于 ${time(t.queued_at)}`
                              : time(t.created_at)}
                        </span>
                        <ArrowUpRight size={15} />
                      </div>
                      {t.state.startsWith("running") && (
                        <div className="progress-line">
                          <i />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                <div className="detail-panel">
                  {current ? (
                    <Detail
                      task={current}
                      busy={busy}
                      action={taskAction}
                      onImage={(images, index) =>
                        setLightbox({ images, index })
                      }
                      copy={copyText}
                    />
                  ) : (
                    <div className="select-empty">
                      <Layers3 size={36} />
                      <h3>选择一个选题</h3>
                      <p>查看生成进度，审核图片与文案</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <Empty
                filtered={!!account || !!query || filter !== "all"}
                importAction={() => setShowImport(true)}
              />
            ))}
          {page === "library" &&
            (tasks.length ? (
              <div className="library-grid">
                {tasks.map((t) => (
                  <article className="material-card" key={t.id}>
                    <button
                      className="material-open"
                      onClick={() => setSelected(t.id)}
                    >
                      <div className="material-cover">
                        {t.images[0] && (
                          <img src={t.images[0].url} alt={t.topic} />
                        )}
                        <Badge state={t.state} />
                      </div>
                      <div className="material-info">
                        <span>
                          {t.account} <span>· {t.images.length} 张图片</span>
                        </span>
                        <h3>{t.topic}</h3>
                        <div>
                          {t.title}
                          <ArrowUpRight size={16} />
                        </div>
                      </div>
                    </button>
                    {filter === "ready" && t.state === "ready" && (
                      <div className="material-actions">
                        <button
                          className="material-delete"
                          disabled={busy}
                          aria-label={`删除素材：${t.topic}`}
                          title="删除素材"
                          onClick={() => setDeleteTarget(t)}
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                <FolderOpen size={34} />
                <h2>好内容，值得留在这里</h2>
                <p>图片和文案审核通过后，会自动进入素材库。</p>
                <button
                  className="secondary"
                  onClick={() => changePage("work")}
                >
                  前往生成工作台 <ArrowRight size={15} />
                </button>
              </div>
            ))}
          {page === "publish" && (
            <div className="publish-panel">
              {current && current.state === "ready" ? (
                <>
                  <div className="publish-heading">
                    <div>
                      <span className="eyebrow">PICKED FOR YOU</span>
                      <h2>{current.topic}</h2>
                      <span className="muted">
                        {current.account} · 未发布 · 本轮第 {excluded.length} 组
                      </span>
                    </div>
                    <div className="button-row">
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => pick()}
                      >
                        <RefreshCw size={15} />
                        换一组
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            await api(`/api/tasks/${current.id}/publish`, {
                              version: current.version,
                            });
                            setCandidate(null);
                            setNotice("已标记为发布");
                            setPicked(false);
                          })
                        }
                      >
                        <Check size={16} />
                        发布 · 标记已发布
                      </button>
                    </div>
                  </div>
                  <Detail
                    task={current}
                    busy={busy}
                    action={taskAction}
                    onImage={(images, index) => setLightbox({ images, index })}
                    copy={copyText}
                    hideHeader
                    openImages={() =>
                      action(async () => {
                        await api(
                          `/api/materials/${current.id}/open-images`,
                          {},
                        );
                        setNotice("已请求打开本地图片文件夹");
                      })
                    }
                  />
                </>
              ) : (
                <div className="empty">
                  <div className="empty-art">
                    <Send size={35} />
                    <Sparkles size={19} />
                  </div>
                  <h2>
                    {picked ? "本轮已经看完了" : "下一篇笔记，从这里开始"}
                  </h2>
                  <p>
                    {picked
                      ? "没有更多符合条件的未发布素材。可以重新开始挑选，或切换账号。"
                      : "为你挑选一组完整素材，图片、文案都已准备好。"}
                  </p>
                  <button
                    className="primary"
                    disabled={busy || data.counts.ready === 0}
                    onClick={() => pick(true)}
                  >
                    <Sparkles size={16} />
                    {picked ? "重新开始挑选" : "挑选一组素材"}
                  </button>
                  <small>
                    发布按钮只记录发布状态，请自行在小红书完成发布。
                  </small>
                </div>
              )}
            </div>
          )}
          <footer>
            每一次创作，都向前一步。<span>素材保存在这台电脑上</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast">
          <CheckCircle2 size={18} />
          {notice}
        </div>
      )}
      {showImport && (
        <ImportModal
          close={() => setShowImport(false)}
          complete={async (ids: string[]) => {
            await load();
            setShowImport(false);
            changePage("work");
            setSelected(ids[0] ?? null);
            setNotice(`已导入 ${ids.length} 个选题`);
          }}
        />
      )}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onClick={busy ? undefined : () => setDeleteTarget(null)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="delete-title">删除这组素材？</h2>
            <p>
              {deleteTarget.account} · {deleteTarget.topic}
            </p>
            <p className="muted">
              将永久删除整组图片、文案、数据库记录及相关生成文件，无法撤销。
            </p>
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(
                      `/api/materials/${deleteTarget.id}`,
                      { version: deleteTarget.version },
                      "DELETE",
                    );
                    setSelected(null);
                    setCandidate(null);
                    setDeleteTarget(null);
                    setNotice("素材已删除");
                  })
                }
              >
                <Trash2 size={16} />
                {busy ? "正在删除…" : "删除整组素材"}
              </button>
            </div>
          </div>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <div className="modal settings" onClick={(e) => e.stopPropagation()}>
            <ModalHead title="运行设置" close={() => setSettings(false)} />
            <p className="muted">
              生成使用当前 Codex 的 ChatGPT 订阅。配置修改后重启生效。
            </p>
            <div className="settings-grid">
              <span>模型</span>
              <strong>{data.config.model}</strong>
              <span>思考程度</span>
              <strong>{data.config.effort}</strong>
              <span>总并发上限</span>
              <strong>{data.queue.concurrency} 个任务</strong>
              <span>网络代理</span>
              <strong>{data.config.proxyHost}</strong>
            </div>
            <div className="hint">
              并发上限仅约束本工具，不代表账号整体的安全上限。
            </div>
            <h3>环境检查</h3>
            {data.checks.map((c) => (
              <div className="check-row" key={c.name}>
                {c.ok ? (
                  <CheckCircle2 size={17} />
                ) : (
                  <AlertCircle size={17} className="danger" />
                )}
                <div>
                  <strong>{c.name}</strong>
                  <p>{c.message}</p>
                </div>
              </div>
            ))}
            <div className="config-note">
              <strong>文件位置</strong>
              <p>
                运行参数：<code>config.toml</code>
                <br />
                图片提示词：<code>prompts/images.md</code>
                <br />
                文案提示词：<code>prompts/copy.md</code>
              </p>
              <p>点击重新生成会读取最新提示词，并删除旧结果。</p>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => action(() => api("/api/check", {}))}
            >
              <RefreshCw size={15} />
              重新检查
            </button>
          </div>
        </div>
      )}
      {page === "library" && current && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <ModalHead title="素材详情" close={() => setSelected(null)} />
            <Detail
              task={current}
              busy={busy}
              action={taskAction}
              onImage={(images, index) => setLightbox({ images, index })}
              copy={copyText}
            />
          </div>
        </div>
      )}
      {lightbox && (
        <Lightbox
          {...lightbox}
          close={() => setLightbox(null)}
          change={(index) => setLightbox({ ...lightbox, index })}
        />
      )}
    </div>
  );
}
function Stat({
  icon,
  title,
  value,
  detail,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  value: number;
  detail: string;
  color: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{title}</span>
        <div className={"stat-icon " + color}>{icon}</div>
      </div>
      <div className="stat-number">
        {value}
        <span>{detail}</span>
      </div>
    </div>
  );
}
function ModalHead({ title, close }: { title: string; close: () => void }) {
  return (
    <div className="modal-head">
      <h2>{title}</h2>
      <button className="icon-button" onClick={close} aria-label="关闭">
        <X size={20} />
      </button>
    </div>
  );
}
function Empty({
  filtered,
  importAction,
}: {
  filtered: boolean;
  importAction: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty-art">
        <Layers3 size={39} />
        <Sparkles size={19} />
      </div>
      <h2>
        {filtered ? "暂时没有符合条件的任务" : "把灵感带进来，剩下的交给工作台"}
      </h2>
      <p>
        {filtered
          ? "试试其他账号、状态或关键词。"
          : "导入包含「账号名」和「主题」的选题表，开始你的第一组素材。"}
      </p>
      {!filtered && (
        <>
          <button className="primary" onClick={importAction}>
            <Upload size={16} />
            导入 XLSX 选题表
          </button>
          <div className="flow">
            <span>01 导入选题</span>
            <ArrowRight size={14} />
            <span>02 图片审核</span>
            <ArrowRight size={14} />
            <span>03 文案审核</span>
            <ArrowRight size={14} />
            <span>04 素材入库</span>
          </div>
        </>
      )}
    </div>
  );
}
function Detail({
  task: t,
  busy,
  action,
  onImage,
  copy,
  hideHeader = false,
  openImages,
}: {
  task: Task;
  busy: boolean;
  action: (t: Task, k: string) => unknown;
  onImage: (images: ImageAsset[], index: number) => void;
  copy: (t: Task) => unknown;
  hideHeader?: boolean;
  openImages?: () => void;
}) {
  return (
    <div className="detail">
      {!hideHeader && (
        <div className="detail-head">
          <div>
            <span className="muted">{t.account}</span>
            <h2>{t.topic}</h2>
          </div>
          <Badge state={t.state} />
        </div>
      )}
      <div className="steps">
        {["图片生成", "图片审核", "文案生成", "文案审核"].map((label, i) => {
          const step = t.state.includes("images")
            ? t.state === "review_images"
              ? 1
              : 0
            : t.state === "review_copy"
              ? 3
              : ["ready", "published"].includes(t.state)
                ? 4
                : 2;
          return (
            <span
              key={label}
              className={i < step ? "done" : i === step ? "current" : ""}
            >
              <b>{i < step ? <Check size={12} /> : i + 1}</b>
              {label}
            </span>
          );
        })}
      </div>
      {t.error && (
        <div className="alert error">
          <AlertCircle size={16} />
          <span>
            {t.error}
            {t.next_at > Date.now() && ` · ${time(t.next_at)} 后重试`}
          </span>
        </div>
      )}
      {t.images.length > 0 ? (
        <>
          <div className="detail-label">
            <div className="image-group-heading">
              <strong>图片组</strong>
              {openImages && (
                <button
                  className="icon-button"
                  disabled={busy}
                  onClick={openImages}
                  title="打开本地图片文件夹"
                  aria-label="打开本地图片文件夹"
                >
                  <FolderOpen size={18} />
                </button>
              )}
            </div>
            <span>{t.images.length} 张原图 · 点击放大</span>
          </div>
          <div className="image-grid">
            {t.images.map((im, i) => (
              <button
                key={im.id}
                className={i === 0 ? "cover" : ""}
                onClick={() => onImage(t.images, i)}
              >
                <img
                  src={im.url}
                  alt={i === 0 ? "案例总览首图" : `详情图 ${i}`}
                  loading="lazy"
                />
                <span>{i === 0 ? "首图" : `详情 ${i}`}</span>
              </button>
            ))}
          </div>
          {t.warning && <div className="image-warning">{t.warning}</div>}
        </>
      ) : (
        <div className="generation-placeholder">
          {t.state.startsWith("running") ? (
            <LoaderCircle size={29} className="spin" />
          ) : (
            <Images size={32} />
          )}
          <h3>{labels[t.state]}</h3>
          <p>
            {t.progress || "任务进度会自动保存在本地，关闭页面不影响生成。"}
          </p>
        </div>
      )}
      {t.body && (
        <div className="copy-panel">
          <div className="detail-label">
            <strong>小红书文案</strong>
            <button className="text-button" onClick={() => copy(t)}>
              <Copy size={13} />
              复制
            </button>
          </div>
          <h3>{t.title}</h3>
          <p>{t.body}</p>
          <small>
            标题 {Array.from(t.title ?? "").length} 字符 · 正文{" "}
            {Array.from(t.body.replace(/\s/g, "")).length} 字符
          </small>
        </div>
      )}
      {t.state.startsWith("running") && t.images.length > 0 && (
        <div className="inline-progress">
          <LoaderCircle className="spin" size={17} />
          {t.progress}
        </div>
      )}
      <div className="detail-actions">
        {t.images.length > 0 && (
          <a className="secondary" href={`/api/tasks/${t.id}/download`}>
            <Download size={14} />
            下载素材
          </a>
        )}
        {t.images.length > 0 && ["ready", "published"].includes(t.state) && (
          <a
            className="secondary"
            href={`/api/tasks/${t.id}/download?imagesOnly=true`}
          >
            <Images size={14} />
            仅图片
          </a>
        )}
        <div className="spacer" />
        {t.state.startsWith("review") && (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => action(t, "regenerate")}
            >
              <RefreshCw size={15} />
              重新生成
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => action(t, "approve")}
            >
              <Check size={16} />
              {t.state === "review_images"
                ? "通过，生成文案"
                : "通过，保存素材"}
            </button>
          </>
        )}
        {["failed", "blocked"].includes(t.state) && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => action(t, "retry")}
          >
            <RefreshCw size={15} />
            重试此阶段
          </button>
        )}
      </div>
      {t.state.startsWith("review") && (
        <p className="action-hint">
          重新生成将删除当前{t.state === "review_images" ? "图片组" : "文案"}
          ，并读取最新提示词。
        </p>
      )}
    </div>
  );
}
function ImportModal({
  close,
  complete,
}: {
  close: () => void;
  complete: (ids: string[]) => void;
}) {
  const [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [keep, setKeep] = useState(false),
    [filename, setFilename] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setFilename(file.name);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/import/preview", {
        method: "POST",
        body: form,
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setPreview(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const count =
    preview?.rows.filter((r: any) => !r.error && (keep || !r.duplicate))
      .length ?? 0;
  const commit = async () => {
    setBusy(true);
    try {
      const result = await api("/api/import/commit", {
        id: preview.id,
        keepDuplicates: keep,
      });
      complete(result.ids);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : close}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <ModalHead title="导入选题" close={busy ? () => {} : close} />
        <p className="muted">
          读取 Excel 第一张工作表，使用「账号名」与「主题」两列。
        </p>
        <input
          ref={input}
          type="file"
          accept=".xlsx"
          hidden
          onChange={(e) => upload(e.target.files?.[0])}
        />
        <button
          disabled={busy}
          className="upload-zone"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy) void upload(e.dataTransfer.files[0]);
          }}
        >
          {busy ? (
            <LoaderCircle className="spin" size={28} />
          ) : (
            <FileSpreadsheet size={30} />
          )}
          <strong>{filename || "点击选择或拖入 XLSX 文件"}</strong>
          <span>最大 20 MB · 单次最多 5000 条选题</span>
        </button>
        {error && <div className="alert error">{error}</div>}
        {preview && (
          <>
            <div className="import-summary">
              <span>
                可导入 <b>{count}</b> 条
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={keep}
                  onChange={(e) => setKeep(e.target.checked)}
                />
                保留重复选题
              </label>
            </div>
            <div className="import-table">
              <table>
                <thead>
                  <tr>
                    <th>行</th>
                    <th>账号</th>
                    <th>主题</th>
                    <th>检查</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r: any) => (
                    <tr key={r.row}>
                      <td>{r.row}</td>
                      <td>{r.account || "—"}</td>
                      <td>{r.topic || "—"}</td>
                      <td>
                        <span
                          className={
                            r.error
                              ? "danger"
                              : r.duplicate
                                ? "amber"
                                : "green-text"
                          }
                        >
                          {r.error ??
                            (r.duplicate
                              ? keep
                                ? "保留重复"
                                : "跳过重复"
                              : "可导入")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !count}
            onClick={commit}
          >
            导入并开始生成 <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
function Lightbox({
  images,
  index,
  close,
  change,
}: {
  images: ImageAsset[];
  index: number;
  close: () => void;
  change: (n: number) => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") change((index + 1) % images.length);
      if (e.key === "ArrowLeft")
        change((index + images.length - 1) % images.length);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index]);
  return (
    <div className="lightbox" onClick={close}>
      <button className="lightbox-close" onClick={close} aria-label="关闭图片">
        <X />
      </button>
      <button
        className="lightbox-prev"
        aria-label="上一张"
        onClick={(e) => {
          e.stopPropagation();
          change((index + images.length - 1) % images.length);
        }}
      >
        <ChevronLeft />
      </button>
      <img
        src={images[index].url}
        alt={`图片 ${index + 1}`}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        className="lightbox-next"
        aria-label="下一张"
        onClick={(e) => {
          e.stopPropagation();
          change((index + 1) % images.length);
        }}
      >
        <ChevronRight />
      </button>
      <span>
        {index + 1} / {images.length} · {images[index].width} ×{" "}
        {images[index].height}
      </span>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
