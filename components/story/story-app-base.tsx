"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpenIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";

/* 三条粗横条的实心菜单图标，与实心图标集的笔画粗细一致 */
function SolidMenuIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4.6" width="18" height="2.8" />
      <rect x="3" y="10.6" width="18" height="2.8" />
      <rect x="3" y="16.6" width="18" height="2.8" />
    </svg>
  );
}

/* 粗笔画「‹」返回图标，笔画粗细与菜单横条一致 */
function SolidBackIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5 L8 12 L15 19"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  hydrateStoryStorage,
  loadStoryMessages,
  loadStorySessions,
  pushStoryMessage,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryMessage,
  type StorySession,
  updateStorySession,
} from "@/lib/story-storage";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";
import { loadStoryMemory, saveStoryMemory, generateStoryMemorySummary, listStoryMemoryRevisions, resolveStoryMemoryContext, defaultStoryMemoryState, DEFAULT_STORY_SUMMARY_PROMPT, DEFAULT_SEGMENT_PROMPT, isMemoryRunning, resolveMemorySummaryApi, type StoryMemoryState, type StoryMemoryRevision } from "@/lib/story-memory-manager";
import { MemoryTaskPanel } from "./memory-task-panel";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveAuxiliaryApiConfig } from "@/lib/settings-storage";

type StoryAppProps = {
  onClose: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  const source = last.renderedContent || last.rawContent || "";
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
}: {
  characterName: string;
  avatar?: string;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant">
      <div className="story-msg-head">
        <div className="story-avatar-wrap">
          <Avatar src={avatar || undefined} name={characterName} size="md" />
        </div>
        <div className="story-msg-meta">
          <span className="story-msg-name">{characterName}</span>
          <span className="story-msg-time story-generating-head">{status}</span>
        </div>
      </div>
      <div className="story-bubble-wrap">
        <div className="story-bubble story-generating-bubble" aria-label="正在生成剧情">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  characterName,
  isGenerating,
  appendRequest,
  onSend,
  onStop,
}: {
  characterName: string;
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer">
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => resizeStoryComposerTextarea(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={`以你和“${characterName}”为主角继续这一段剧情……`}
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <StopIcon width={17} height={17} /> : <PaperAirplaneIcon width={17} height={17} className="story-send-icon" />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  // 生成状态按会话记录：避免在 A 会话生成时切到 B 会话也显示"正在生成"
  const [generatingSessionIds, setGeneratingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // 抽屉滑动手势用 ref 而不是 state：手指按住时 touchmove 每帧都在触发，
  // 逐帧 setState 会让整个剧情页以事件频率重渲染（iOS 上拉到顶/底按住不动时
  // 表现为持续的重排/闪烁）
  const dragStartXRef = useRef<number | null>(null);
  const dragDeltaXRef = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryState, setMemoryState] = useState<StoryMemoryState | null>(null);
  const [memoryRevisions, setMemoryRevisions] = useState<StoryMemoryRevision[]>([]);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryRunning,setMemoryRunning]=useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const uiPrefs = currentSession?.uiPrefs || {};
  const isGenerating = Boolean(activeSessionId) && generatingSessionIds.has(activeSessionId);

  const markGenerating = useCallback((sessionId: string, on: boolean) => {
    setGeneratingSessionIds((prev) => {
      if (on === prev.has(sessionId)) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      const initialChar = loadCharacters()[0]?.id || "";
      if (initialChar) {
        const session = createOrGetStorySession(initialChar);
        setActiveCharacterId(initialChar);
        setActiveSessionId(session.id);
        activeSessionIdRef.current = session.id; // 同步更新，堵住生成完成回调的守卫空窗
        setVisibleMessageCount(STORY_INITIAL_LOAD);
        setMessages(loadStoryMessages(session.id));
        setCustomCssDraft(session.customCSS || "");
        setFoldTagsDraft(session.foldTags ?? "think,thinking");
        setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking");
        setStorageVersion((value) => value + 1);
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!activeCharacterId) return;
    const session = createOrGetStorySession(activeCharacterId);
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id; // 同步更新，堵住生成完成回调的守卫空窗
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setCustomCssDraft(session.customCSS || "");
    setFoldTagsDraft(session.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }, [activeCharacterId]);

  useEffect(() => {
    if (!activeSessionId) return;
    let active = true;
    Promise.all([loadStoryMemory(activeSessionId), listStoryMemoryRevisions(activeSessionId)]).then(([state, revisions]) => {
      if (active) { setMemoryState(state); setMemoryRevisions(revisions); }
    }).catch(console.error);
    return () => { active = false; };
  }, [activeSessionId, memoryOpen]);
  useEffect(()=>{if(!activeSessionId)return;let wasRunning=false;let alive=true;const tick=()=>{const running=isMemoryRunning(activeSessionId);setMemoryRunning(running);if(wasRunning&&!running)void loadStoryMemory(activeSessionId).then(s=>{if(alive)setMemoryState(s);});wasRunning=running;};tick();const t=setInterval(tick,500);return()=>{alive=false;clearInterval(t);};},[activeSessionId]);

  const persistMemory = async (next: StoryMemoryState) => {
    try {
      await saveStoryMemory(next, "manual", [], next);
      setMemoryState(await loadStoryMemory(next.sessionId));
      setMemoryRevisions(await listStoryMemoryRevisions(next.sessionId));
    } catch(e) { alert(e instanceof Error ? e.message : "保存失败"); }
  };
  const regenerateMemory = async (rebuild = false) => {
    if (!memoryState || !activeCharacterId) return;
    const bound = resolveBinding(loadBindingConfig(), activeCharacterId, "story");
    const fallback = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.id === bound.apiConfigId) || loadApiConfigs().find(c=>c.id===memoryState.summaryApiConfigId);
    const config = fallback ? resolveMemorySummaryApi(memoryState,fallback) : undefined;
    if (!config) { alert("请先绑定剧情 API 或辅助记忆总结 API"); return; }
    if (!confirm(`将调用 ${config.defaultModel} ${rebuild ? "从原文重建全部可压缩的剧情摘要和索引" : "对旧剧情进行分段摘要"}，可能产生多次 API 费用。继续？`)) return;
    setMemoryBusy(true);
    try {
      const next = await generateStoryMemorySummary(activeSessionId, loadStoryMessages(activeSessionId), rebuild ? {...memoryState,summaryText:"",coveredThroughMessageId:null,coveredDigest:"",task:undefined} : memoryState, config);
      setMemoryState(next);
      setMemoryRevisions(await listStoryMemoryRevisions(activeSessionId));
      alert(next.task?.status==="paused"?"已暂停，成功分段已保存。":"剧情摘要生成完成。请在提示词查看器中检查实际请求内容。");
    } catch(e) { setMemoryState(await loadStoryMemory(activeSessionId)); alert(e instanceof Error ? e.message : "摘要生成失败"); }
    finally { setMemoryBusy(false); }
  };

  // Listen for live CSS updates from 小卷
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    // 已经贴底（或 iOS 橡皮筋回弹超出底部）时不再强写 scrollTop：
    // 否则 ResizeObserver → 贴底 → scroll 事件 → 再贴底会形成每帧循环，
    // 并和 iOS 的回弹动画互相打架
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    // 配置解析可能抛错（如绑定的 API 配置已被删除）；这里在渲染 effect 里，
    // 抛出去会让整个剧情页白屏，所以失败时跳过缓存刷新，错误留到发送时提示
    let signature: { regexSignature: string; parserVersion: number };
    try {
      signature = getStoryRenderSignature(activeCharacterId);
    } catch {
      return;
    }
    const { regexSignature, parserVersion } = signature;
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      let rebuilt: StoryMessage[];
      try {
        rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
      } catch {
        if (cacheRefreshKeyRef.current === refreshKey) cacheRefreshKeyRef.current = null;
        return;
      }
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
    // 依赖用 id/foldTags 原始值而不是 session 对象：会话缓存归一化会更换对象
    // 引用，按对象依赖会让本 effect 在无关渲染中反复重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeCharacterId, currentSession?.id, currentSession?.foldTags, messages, isGenerating]);

  function applySessionUpdates(updates: Partial<StorySession>) {
    if (!currentSession) return;
    const next = updateStorySession(currentSession.id, updates);
    if (!next) return;
    setCustomCssDraft(next.customCSS || "");
    setFoldTagsDraft(next.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(next.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }

  async function handleSend(userTextInput: string) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId)); // 按会话从存储重读，杜绝跨会话串消息
      }
      setStorageVersion((value) => value + 1);

      const storyCharacter = characters.find((character) => character.id === characterId);
      if (storyCharacter) {
        void (async () => {
          try {
            incrementEventCounter(characterId);
            incrementEventCounter(characterId);
            await maybeRunSummarization(characterId, storyCharacter.name);
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId));
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    markGenerating(activeSessionId, false);
  }

  function handleTouchStart(clientX: number) {
    dragStartXRef.current = clientX;
    dragDeltaXRef.current = 0;
  }

  function handleTouchMove(clientX: number) {
    if (dragStartXRef.current == null) return;
    dragDeltaXRef.current = clientX - dragStartXRef.current;
  }

  function handleTouchEnd() {
    const dragStartX = dragStartXRef.current;
    const dragDeltaX = dragDeltaXRef.current;
    if (dragStartX == null) return;
    // 从右边缘向左滑打开
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (!drawerOpen && dragStartX > screenW - 32 && dragDeltaX < -54) {
      setDrawerOpen(true);
    }
    // 向右滑关闭
    if (drawerOpen && dragDeltaX > 54) {
      setDrawerOpen(false);
    }
    dragStartXRef.current = null;
    dragDeltaXRef.current = 0;
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    // 重试会截掉一条长消息，内容变矮时浏览器把滚动位置钳回新底部，
    // 看起来像"页面跳到上面"；这里主动贴底，让视线落在生成指示器上
    autoBottomLockRef.current = true;
    requestAnimationFrame(() => scrollStoryToBottom());
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <SolidBackIcon size={16} />
                </button>
              </div>
              <div className="story-header-center">Story</div>
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <BookOpenIcon width={30} height={30} opacity={0.45} />
                <div>
                  <div className="story-empty-title">还没有角色卡</div>
                  <div className="story-empty-desc">请先创建或导入角色卡，再进入剧情 APP 开始故事。</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  返回
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  const sessionScope = `.story-session-${currentSession.id}`;

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartXRef.current != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {currentSession.customCSS ? (
        <SessionCustomCSS css={currentSession.customCSS} scope={sessionScope} />
      ) : null}

      {drawerOpen ? <div className="story-drawer-overlay" onClick={() => setDrawerOpen(false)} /> : null}
      <aside className="story-drawer" style={{ transform: drawerOpen ? "translateX(0)" : "translateX(106%)", transition: "transform 220ms ease" }}>
        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">剧情角色</div>
          <div className="story-character-list">
            {characters.map((character) => (
              <button
                key={character.id}
                className="story-character-chip"
                data-active={character.id === activeCharacterId ? "true" : undefined}
                onClick={() => {
                  setActiveCharacterId(character.id);
                  setDrawerOpen(false);
                }}
              >
                <Avatar src={character.avatar || undefined} name={character.name} size="lg" />
                <span className="story-character-name">{character.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">显示选项</div>
          <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(124, 104, 68, 0.08))" }}>
            <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))", display: "block", marginBottom: 6 }}>
              折叠标签
            </label>
            <input
              type="text"
              value={foldTagsDraft}
              onChange={(e) => setFoldTagsDraft(e.target.value)}
              onBlur={() => applySessionUpdates({ foldTags: foldTagsDraft.trim() || undefined })}
              placeholder="think,thinking"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 12px", borderRadius: 0,
                border: "none", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.06)",
                background: "var(--c-story-css-box-bg, rgba(255, 251, 246, 0.88))",
                color: "var(--c-story-text, #4b4335)",
                fontSize: "calc(13px*var(--app-text-scale,1))", lineHeight: 1.6, fontFamily: "inherit",
              }}
            />
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4, color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
              逗号分隔标签名，如 think,thinking,reasoning
            </div>
          </div>
          <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(124, 104, 68, 0.08))" }}>
            <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))", display: "block", marginBottom: 6 }}>
              不进上下文标签
            </label>
            <input
              type="text"
              value={contextExcludedTagsDraft}
              onChange={(e) => setContextExcludedTagsDraft(e.target.value)}
              onBlur={() => applySessionUpdates({ contextExcludedTags: contextExcludedTagsDraft.trim() || undefined })}
              placeholder="think,thinking"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 12px", borderRadius: 0,
                border: "none", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.06)",
                background: "var(--c-story-css-box-bg, rgba(255, 251, 246, 0.88))",
                color: "var(--c-story-text, #4b4335)",
                fontSize: "calc(13px*var(--app-text-scale,1))", lineHeight: 1.6, fontFamily: "inherit",
              }}
            />
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4, color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
              默认 think,thinking；影响后续生成上下文，不影响显示与保存
            </div>
          </div>
        </div>

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">工具</div>
          <button className="story-tool-btn" onClick={() => { setDrawerOpen(false); setMemoryOpen(true); }}>剧情记忆管理</button>
          <button
            className="story-tool-btn"
            onClick={() => {
              try {
                const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
                setMessages(rebuilt);
                setStorageVersion((value) => value + 1);
                alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
              } catch (error) {
                alert(error instanceof Error ? error.message : "缓存重建失败，请检查 API 绑定配置");
              }
            }}
          >
            重建渲染缓存
          </button>
        </div>
      </aside>

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                <SolidBackIcon size={16} />
              </button>
            </div>
            <div className="story-header-center">Story</div>
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="页面样式">
                <PaintBrushIcon width={16} height={16} />
              </button>
              <button className="story-top-btn" onClick={() => setDrawerOpen(true)} aria-label="打开剧情侧栏">
                <SolidMenuIcon size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">
            
            {/* ====== 顶部信息阅读卡片 ====== */}
            <div className="story-meta">
              <div className="story-meta-layout">
                <div className="story-meta-cover">
                  {currentCharacter.avatar ? (
                    <img src={currentCharacter.avatar} alt="cover" />
                  ) : (
                    <div className="story-meta-cover-fallback" aria-hidden="true">
                      <span className="story-meta-cover-char">{currentCharacter.name.trim().charAt(0) || "书"}</span>
                      <span className="story-meta-cover-line" />
                      <span className="story-meta-cover-sub">STORY</span>
                    </div>
                  )}
                </div>
                <div className="story-meta-body">
                  <div className="story-meta-title">本次阅读：《 {currentCharacter.name} 》</div>
                  <div className="story-meta-tags">
                    {userIdentity?.name || "我"} x {currentCharacter.name}
                  </div>
                  <div className="story-meta-desc">
                    {/* Character type might not have description, so we use a stylized default text */}
                    “有些故事，在开始之前就已经写好了结局。”
                  </div>
                </div>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="story-empty">
                <BookOpenIcon width={28} height={28} opacity={0.45} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">故事从这里开始</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">从底部输入一段引导，剧情会继续展开。</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? currentCharacter.name
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {message.role !== "system" ? (
                        <div className="story-msg-head">
                          <div className="story-avatar-wrap">
                            <Avatar src={avatarUrl} name={speakerName} size="md" />
                          </div>
                          <div className="story-msg-meta">
                            <span className="story-msg-name">{speakerName}</span>
                            <span className="story-msg-time">{formatStoryTime(message.createdAt)}</span>
                          </div>
                        </div>
                      ) : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                              </div>
                            </div>
                          ) : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                              serifIframeFallback
                            />
                          )}
                        </div>
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">复制</button>
                                <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">编辑</button>
                                {(message.role === "assistant" || message.role === "user") && (
                                  <button onClick={() => { void handleStoryRetry(message.id); }} className="story-ctx-btn story-ctx-btn-danger">重试</button>
                                )}
                              </div>
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除以下</button>
                              </div>
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={currentCharacter.name}
                avatar={currentCharacter.avatar || undefined}
              />
            ) : null}
          </div>
        </div>
      </div>

      <StoryComposer
        characterName={currentCharacter.name}
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        onSend={(text) => { void handleSend(text); }}
        onStop={handleStopGeneration}
      />

      {/* CSS Style Modal */}
      {!memoryOpen&&(memoryRunning||memoryState?.task?.status==="failed"||memoryState?.task?.status==="paused")&&<button onClick={()=>setMemoryOpen(true)} style={{position:"fixed",top:64,right:14,zIndex:500,background:"#dce6ff",color:"#334",padding:8,borderRadius:10}}>{memoryRunning?"溯章正在整理记忆 · 查看进度":memoryState?.task?.status==="failed"?"溯章摘要失败 · 查看 / 续作":"溯章已暂停 · 继续任务"}</button>}
      {memoryOpen && memoryState && memoryState.sessionId===activeSessionId && (
        <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.65)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#fffdf9",color:"#39352f",borderRadius:14,padding:18,width:"100%",maxWidth:600,maxHeight:"88vh",overflowY:"auto",display:"grid",gap:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><strong>剧情记忆管理</strong><button onClick={()=>setMemoryOpen(false)}>关闭 ✕</button></div>
            <MemoryTaskPanel sessionId={activeSessionId} onChanged={()=>void loadStoryMemory(activeSessionId).then(setMemoryState)}/>
            <label>摘要模型绑定 <select disabled={memoryBusy||memoryRunning} value={memoryState.summaryApiConfigId??""} onChange={e=>setMemoryState({...memoryState,summaryApiConfigId:e.target.value||undefined})}><option value="">辅助记忆总结 API（未设置则剧情 API）</option>{loadApiConfigs().map(c=><option key={c.id} value={c.id}>{c.name||c.defaultModel} · {c.defaultModel}</option>)}</select></label>
            <label><input type="checkbox" checked={memoryState.enabled} onChange={e=>setMemoryState({...memoryState,enabled:e.target.checked})}/> 启用摘要压缩（保存后生效）</label>
            <label>保留最近完整对话轮数 <input type="number" min={2} max={30} value={memoryState.recentTurns} onChange={e=>setMemoryState({...memoryState,recentTurns:Math.max(2,Math.min(30,Number(e.target.value)||6))})} style={{width:70,marginLeft:8}} /></label>
            <label>自动摘要 Token 阈值 <input type="number" min={2000} step={1000} value={memoryState.triggerTokens} onChange={e=>setMemoryState({...memoryState,triggerTokens:Number(e.target.value)||20000})} style={{width:100,marginLeft:8}} /> tokens</label>
            <label>自动摘要触发模式 <select value={memoryState.triggerMode ?? "hybrid"} onChange={e=>setMemoryState({...memoryState,triggerMode:e.target.value as StoryMemoryState["triggerMode"]})} style={{marginLeft:8}}><option value="hybrid">混合：条数或 Token 达标</option><option value="count">仅按消息条数</option><option value="tokens">仅按 Token</option><option value="manual">仅手动生成</option></select></label>
            <label>自动摘要消息阈值 <input type="number" min={2} max={500} value={memoryState.triggerMessages ?? 20} onChange={e=>setMemoryState({...memoryState,triggerMessages:Math.max(2,Number(e.target.value)||20)})} style={{width:80,marginLeft:8}} /> 条</label>
            <small>自动与手动总结使用同一摘要 API 绑定，产生额外费用；每段成功保存后才裁剪对应旧正文。调整参数后请点击保存。</small>
            <label><input type="checkbox" checked={memoryState.recallEnabled !== false} onChange={e=>setMemoryState({...memoryState,recallEnabled:e.target.checked})}/> 启用相关历史剧情检索（使用绑定的 Embedding API，未配置则关键词检索）</label>
            <label>召回历史分段数 <select value={memoryState.recallTopK ?? 4} onChange={e=>setMemoryState({...memoryState,recallTopK:Number(e.target.value)})}><option value={3}>3</option><option value={4}>4</option><option value={5}>5</option></select></label>
            <small>正式生成时使用向量检索；预览仅进行关键词检索，不额外调用剧情 Embedding API。</small>
            <details style={{border:"1px solid #ddd5c9",borderRadius:10,padding:12}}>
              <summary style={{cursor:"pointer",fontWeight:600}}>跨场景记忆设置</summary>
              <label style={{display:"block",marginTop:8}}>线上 → 线下 <select value={memoryState.crossChatToStory ?? "full"} onChange={e=>setMemoryState({...memoryState,crossChatToStory:e.target.value as StoryMemoryState["crossChatToStory"]})}><option value="full">完整线上聊天</option><option value="summary-recent">摘要 + 近期聊天（预留）</option></select></label>
              <label style={{display:"block",marginTop:8}}>线下 → 线上 <select value={memoryState.crossStoryToChat ?? "summary-recent"} onChange={e=>setMemoryState({...memoryState,crossStoryToChat:e.target.value as StoryMemoryState["crossStoryToChat"]})}><option value="summary-recent">累计摘要 + 近期文末摘要</option><option value="summary">仅累计摘要</option><option value="full">原有事件投影</option></select></label>
              <label style={{display:"block",marginTop:8}}>朋友圈 → 其他场景 <select value={memoryState.crossMoments ?? "summary-recent"} onChange={e=>setMemoryState({...memoryState,crossMoments:e.target.value as StoryMemoryState["crossMoments"]})}><option value="summary-recent">简短历史 + 最近动态</option><option value="recent">仅最近动态</option><option value="full">原有全部动态</option></select></label>
            </details>
            <details style={{border:"1px solid #ddd5c9",borderRadius:10,padding:12}}>
              <summary style={{cursor:"pointer",fontWeight:600}}>「在场」轻量记忆</summary>
              <label style={{display:"block",marginTop:8}}><input type="checkbox" checked={memoryState.interviewEnabled !== false} onChange={e=>setMemoryState({...memoryState,interviewEnabled:e.target.checked})}/> 启用累计摘要 + 最近文末 &lt;summary&gt;</label>
              <label style={{display:"block",marginTop:8}}>最近文末摘要 <input type="number" min={1} max={20} value={memoryState.interviewSummaryTurns ?? 6} onChange={e=>setMemoryState({...memoryState,interviewSummaryTurns:Math.max(1,Math.min(20,Number(e.target.value)||6))})} style={{width:70,marginLeft:8}} /> 轮</label>
              <small>只读取剧情原文中的 &lt;summary&gt; 标签，不读取完整剧情正文。</small>
            </details>
            <details style={{border:"1px solid #ddd5c9",borderRadius:10,padding:12}}>
              <summary style={{cursor:"pointer",fontWeight:600}}>累计摘要提示词（点击展开，可编辑）</summary>
              <p style={{fontSize:12,color:"#6b6258"}}>每条剧情线独立保存。生成 / 更新摘要时会使用这里的规则；修改后请先保存设置。旧版本未设置时自动使用默认模板。</p>
              <textarea aria-label="摘要提示词" rows={14} value={memoryState.summaryPrompt ?? DEFAULT_STORY_SUMMARY_PROMPT} onChange={e=>setMemoryState({...memoryState,summaryPrompt:e.target.value})} style={{width:"100%",boxSizing:"border-box",padding:8,border:"1px solid #bcb5aa",borderRadius:8,color:"#333",background:"white",fontFamily:"inherit",lineHeight:1.6}} />
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                <button type="button" onClick={()=>{if(confirm("恢复默认摘要提示词？尚未保存的修改将被替换。"))setMemoryState({...memoryState,summaryPrompt:DEFAULT_STORY_SUMMARY_PROMPT});}} style={{padding:8,border:"1px solid #ccc",borderRadius:7}}>恢复默认模板</button>
                <button type="button" onClick={()=>window.alert(`${memoryState.supplementalPosition==="before"?memoryState.supplementalPrompt||"":""}\n${memoryState.summaryPrompt?.trim() || DEFAULT_STORY_SUMMARY_PROMPT}\n${memoryState.supplementalPosition!=="before"?memoryState.supplementalPrompt||"":""}\n\n【旧记忆】\n（已有累计摘要）\n【新增分段摘要】\n（本段独立摘要）`)} style={{padding:8,border:"1px solid #ccc",borderRadius:7}}>预览累计摘要请求模板</button>
              </div>
            </details>
            <details><summary>独立分段摘要提示词</summary><textarea rows={8} style={{width:"100%"}} value={memoryState.segmentPrompt??DEFAULT_SEGMENT_PROMPT} onChange={e=>setMemoryState({...memoryState,segmentPrompt:e.target.value})}/><button onClick={()=>setMemoryState({...memoryState,segmentPrompt:DEFAULT_SEGMENT_PROMPT})}>恢复默认</button></details>
            <details><summary>独立补充指令</summary><small>仅注入摘要请求的指令部分，不进入剧情正文或向量查询。</small><select value={memoryState.supplementalPosition??"after"} onChange={e=>setMemoryState({...memoryState,supplementalPosition:e.target.value as "before"|"after"})}><option value="before">摘要模板之前</option><option value="after">摘要模板之后、素材之前</option></select><textarea rows={6} style={{width:"100%"}} value={memoryState.supplementalPrompt??""} onChange={e=>setMemoryState({...memoryState,supplementalPrompt:e.target.value})}/><button onClick={()=>setMemoryState({...memoryState,supplementalPrompt:""})}>清空</button></details>
            <div>当前累计摘要（可编辑）</div>
            <textarea rows={10} value={memoryState.summaryText} onChange={e=>setMemoryState({...memoryState,summaryText:e.target.value})} style={{width:"100%",boxSizing:"border-box",padding:8,border:"1px solid #bcb5aa",borderRadius:8,color:"#333",background:"white"}} />
            <small>摘要覆盖至：{memoryState.coveredThroughMessageId || "尚未生成"}；当前校验：{resolveStoryMemoryContext(messages,memoryState).valid?"有效":"未启用或需重新整理"}</small>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button disabled={memoryBusy||memoryRunning} onClick={()=>void persistMemory(memoryState)} style={{padding:10,background:"#d7e8d8",borderRadius:8}}>保存设置与摘要</button>
              <button disabled={memoryBusy||memoryRunning} onClick={()=>void regenerateMemory()} style={{padding:10,background:"#dce6ff",borderRadius:8}}>{memoryBusy||memoryRunning?"正在分段总结…":memoryState.task&&memoryState.task.status!=="done"?"继续 / 重试摘要":"生成 / 更新摘要（调用 API）"}</button>
              <button disabled={memoryBusy||memoryRunning} onClick={()=>void regenerateMemory(true)} style={{padding:10,border:"1px solid #ccc",borderRadius:8}}>从原文重新整理</button>
            </div>
            <strong>历史版本</strong>
            {memoryRevisions.slice(0,12).map(rev=><button key={rev.id} onClick={()=>{if(confirm("恢复此版本的摘要和覆盖范围？请记得保存。")) setMemoryState({...memoryState,summaryText:rev.summaryText,coveredThroughMessageId:rev.coveredThroughMessageId,coveredDigest:rev.coveredDigest});}} style={{textAlign:"left",padding:8,border:"1px solid #ddd",borderRadius:6}}>{new Date(rev.createdAt).toLocaleString()} · {rev.source} · {rev.summaryText.slice(0,35)}…</button>)}
            <small>原始剧情消息不会被删除。若修改或删除已压缩的旧正文，摘要自动失效并恢复发送原文，避免静默丢失剧情。</small>
          </div>
        </div>
      )}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              页面样式
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <XMarkIcon width={17} height={17} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`切换到${t.name}主题`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 0,
                        border: "none",
                        boxShadow: "none",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: "none",
                        boxShadow: active
                          ? "inset 0 0 0 2px var(--c-story-bg-top, #fdfdfd), 0 0 0 2px var(--c-story-text, #3a3b3c)"
                          : "none",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情模式的 session CSS */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "none",
                borderRadius: 0,
                boxShadow: "none",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0, border: "none", boxShadow: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
