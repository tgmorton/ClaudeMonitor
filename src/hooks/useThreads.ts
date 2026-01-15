import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ApprovalRequest,
  AppServerEvent,
  ClaudeApprovalRequest,
  ClaudeResultEvent,
  ClaudeSessionStartedEvent,
  ClaudeSessionClosedEvent,
  ClaudeMessageDeltaEvent,
  ClaudeMessageCompleteEvent,
  ClaudeToolStartedEvent,
  ClaudeToolProgressEvent,
  ClaudeErrorEvent,
  ConversationItem,
  CustomPromptOption,
  DebugEntry,
  ResultPayload,
  RateLimitSnapshot,
  RewindDiffResult,
  ThreadTokenUsage,
  TurnPlan,
  TurnPlanStep,
  TurnPlanStepStatus,
  WorkspaceInfo,
} from "../types";
import {
  respondToServerRequest,
  sendUserMessage as sendUserMessageService,
  startReview as startReviewService,
  startThread as startThreadService,
  listThreads as listThreadsService,
  resumeThread as resumeThreadService,
  archiveThread as archiveThreadService,
  getAccountRateLimits,
  interruptTurn as interruptTurnService,
  // Claude Agent SDK service functions
  claudeStartSession,
  claudeResumeSession,
  claudeSendMessage,
  claudeInterrupt,
  claudeRespondPermission,
  claudeRewindToMessage,
  // Registry service functions (Agent C)
  getVisibleSessions,
  registryArchiveSession,
  getSessionHistory,
} from "../services/tauri";
// Claude-native: Codex event handling disabled
// import { useAppServerEvents } from "./useAppServerEvents";
import { useClaudeEvents } from "./useClaudeEvents";
import {
  buildConversationItem,
  buildItemsFromThread,
  getThreadTimestamp,
  isReviewingFromThread,
  mergeThreadItems,
  previewThreadName,
} from "../utils/threadItems";
import { expandCustomPromptText } from "../utils/customPrompts";
import { initialState, threadReducer } from "./useThreadsReducer";

const STORAGE_KEY_THREAD_ACTIVITY = "codexmonitor.threadLastUserActivity";

type ThreadActivityMap = Record<string, Record<string, number>>;

function loadThreadActivity(): ThreadActivityMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_THREAD_ACTIVITY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as ThreadActivityMap;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveThreadActivity(activity: ThreadActivityMap) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY_THREAD_ACTIVITY,
      JSON.stringify(activity),
    );
  } catch {
    // Best-effort persistence; ignore write failures.
  }
}

type UseThreadsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onWorkspaceConnected: (id: string) => void;
  onDebug?: (entry: DebugEntry) => void;
  model?: string | null;
  effort?: string | null;
  accessMode?: "read-only" | "current" | "full-access";
  permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk";
  customPrompts?: CustomPromptOption[];
  onMessageActivity?: () => void;
};

function asString(value: unknown) {
  return typeof value === "string" ? value : value ? String(value) : "";
}

function extractRpcErrorMessage(response: unknown) {
  if (!response || typeof response !== "object") {
    return null;
  }
  const record = response as Record<string, unknown>;
  if (!record.error) {
    return null;
  }
  const errorValue = record.error;
  if (typeof errorValue === "string") {
    return errorValue;
  }
  if (typeof errorValue === "object" && errorValue) {
    const message = asString((errorValue as Record<string, unknown>).message);
    return message || "Request failed.";
  }
  return "Request failed.";
}

function parseReviewTarget(input: string) {
  const trimmed = input.trim();
  const rest = trimmed.replace(/^\/review\b/i, "").trim();
  if (!rest) {
    return { type: "uncommittedChanges" } as const;
  }
  const lower = rest.toLowerCase();
  if (lower.startsWith("base ")) {
    const branch = rest.slice(5).trim();
    return { type: "baseBranch", branch } as const;
  }
  if (lower.startsWith("commit ")) {
    const payload = rest.slice(7).trim();
    const [sha, ...titleParts] = payload.split(/\s+/);
    const title = titleParts.join(" ").trim();
    return {
      type: "commit",
      sha,
      ...(title ? { title } : {}),
    } as const;
  }
  if (lower.startsWith("custom ")) {
    const instructions = rest.slice(7).trim();
    return { type: "custom", instructions } as const;
  }
  return { type: "custom", instructions: rest } as const;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeTokenUsage(raw: Record<string, unknown>): ThreadTokenUsage {
  const total = (raw.total as Record<string, unknown>) ?? {};
  const last = (raw.last as Record<string, unknown>) ?? {};
  return {
    total: {
      totalTokens: asNumber(total.totalTokens ?? total.total_tokens),
      inputTokens: asNumber(total.inputTokens ?? total.input_tokens),
      cachedInputTokens: asNumber(
        total.cachedInputTokens ?? total.cached_input_tokens,
      ),
      outputTokens: asNumber(total.outputTokens ?? total.output_tokens),
      reasoningOutputTokens: asNumber(
        total.reasoningOutputTokens ?? total.reasoning_output_tokens,
      ),
    },
    last: {
      totalTokens: asNumber(last.totalTokens ?? last.total_tokens),
      inputTokens: asNumber(last.inputTokens ?? last.input_tokens),
      cachedInputTokens: asNumber(last.cachedInputTokens ?? last.cached_input_tokens),
      outputTokens: asNumber(last.outputTokens ?? last.output_tokens),
      reasoningOutputTokens: asNumber(
        last.reasoningOutputTokens ?? last.reasoning_output_tokens,
      ),
    },
    modelContextWindow: (() => {
      const value = raw.modelContextWindow ?? raw.model_context_window;
      if (typeof value === "number") {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })(),
  };
}

function normalizeClaudeUsage(usage: ResultPayload["usage"]): ThreadTokenUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedInputTokens = usage.cacheReadInputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  return {
    total: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0, // Claude SDK doesn't separate reasoning tokens in result
    },
    last: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: null, // Not provided in Claude result events
  };
}

function normalizeRateLimits(raw: Record<string, unknown>): RateLimitSnapshot {
  const primary = (raw.primary as Record<string, unknown>) ?? null;
  const secondary = (raw.secondary as Record<string, unknown>) ?? null;
  const credits = (raw.credits as Record<string, unknown>) ?? null;
  return {
    primary: primary
      ? {
          usedPercent: asNumber(primary.usedPercent ?? primary.used_percent),
          windowDurationMins: (() => {
            const value = primary.windowDurationMins ?? primary.window_duration_mins;
            if (typeof value === "number") {
              return value;
            }
            if (typeof value === "string") {
              const parsed = Number(value);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          })(),
          resetsAt: (() => {
            const value = primary.resetsAt ?? primary.resets_at;
            if (typeof value === "number") {
              return value;
            }
            if (typeof value === "string") {
              const parsed = Number(value);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          })(),
        }
      : null,
    secondary: secondary
      ? {
          usedPercent: asNumber(secondary.usedPercent ?? secondary.used_percent),
          windowDurationMins: (() => {
            const value = secondary.windowDurationMins ?? secondary.window_duration_mins;
            if (typeof value === "number") {
              return value;
            }
            if (typeof value === "string") {
              const parsed = Number(value);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          })(),
          resetsAt: (() => {
            const value = secondary.resetsAt ?? secondary.resets_at;
            if (typeof value === "number") {
              return value;
            }
            if (typeof value === "string") {
              const parsed = Number(value);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          })(),
        }
      : null,
    credits: credits
      ? {
          hasCredits: Boolean(credits.hasCredits ?? credits.has_credits),
          unlimited: Boolean(credits.unlimited),
          balance: typeof credits.balance === "string" ? credits.balance : null,
        }
      : null,
    planType: typeof raw.planType === "string"
      ? raw.planType
      : typeof raw.plan_type === "string"
        ? raw.plan_type
        : null,
  };
}

function normalizeStreamingText(text: string): string {
  if (!text) {
    return "";
  }
  const unified = text.replace(/\r\n/g, "\n");
  return unified.replace(/([^\n])\n(?!\n)(?![-*]\s)(?!\d+\.\s)(?!```)/g, "$1 ");
}

function normalizePlanStepStatus(value: unknown): TurnPlanStepStatus {
  const raw = typeof value === "string" ? value : "";
  const normalized = raw.replace(/[_\s-]/g, "").toLowerCase();
  if (normalized === "inprogress") {
    return "inProgress";
  }
  if (normalized === "completed") {
    return "completed";
  }
  return "pending";
}

function normalizePlanUpdate(
  turnId: string,
  explanation: unknown,
  plan: unknown,
): TurnPlan | null {
  const steps = Array.isArray(plan)
    ? plan
        .map((entry) => {
          const step = asString((entry as Record<string, unknown>)?.step ?? "");
          if (!step) {
            return null;
          }
          return {
            step,
            status: normalizePlanStepStatus(
              (entry as Record<string, unknown>)?.status,
            ),
          } satisfies TurnPlanStep;
        })
        .filter((entry): entry is TurnPlanStep => Boolean(entry))
    : [];
  const note = asString(explanation).trim();
  if (!steps.length && !note) {
    return null;
  }
  return {
    turnId,
    explanation: note ? note : null,
    steps,
  };
}

function formatReviewLabel(target: ReturnType<typeof parseReviewTarget>) {
  if (target.type === "uncommittedChanges") {
    return "current changes";
  }
  if (target.type === "baseBranch") {
    return `base branch ${target.branch}`;
  }
  if (target.type === "commit") {
    return target.title
      ? `commit ${target.sha}: ${target.title}`
      : `commit ${target.sha}`;
  }
  const instructions = target.instructions.trim();
  if (!instructions) {
    return "custom review";
  }
  return instructions.length > 80
    ? `${instructions.slice(0, 80)}…`
    : instructions;
}

export function useThreads({
  activeWorkspace,
  onWorkspaceConnected,
  onDebug,
  model,
  effort,
  accessMode,
  permissionMode,
  customPrompts = [],
  onMessageActivity,
}: UseThreadsOptions) {
  const [state, dispatch] = useReducer(threadReducer, initialState);
  const loadedThreads = useRef<Record<string, boolean>>({});
  const threadActivityRef = useRef<ThreadActivityMap>(loadThreadActivity());
  const streamingMessageIds = useRef<Record<string, string>>({});
  const pendingSessionByWorkspace = useRef<Record<string, string>>({});

  const recordThreadActivity = useCallback(
    (workspaceId: string, threadId: string, timestamp = Date.now()) => {
      const nextForWorkspace = {
        ...(threadActivityRef.current[workspaceId] ?? {}),
        [threadId]: timestamp,
      };
      const next = {
        ...threadActivityRef.current,
        [workspaceId]: nextForWorkspace,
      };
      threadActivityRef.current = next;
      saveThreadActivity(next);
    },
    [],
  );

  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const activeThreadId = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    return state.activeThreadIdByWorkspace[activeWorkspaceId] ?? null;
  }, [activeWorkspaceId, state.activeThreadIdByWorkspace]);

  const activeItems = useMemo(
    () => (activeThreadId ? state.itemsByThread[activeThreadId] ?? [] : []),
    [activeThreadId, state.itemsByThread],
  );

  const refreshAccountRateLimits = useCallback(
    async (workspaceId?: string) => {
      const targetId = workspaceId ?? activeWorkspaceId;
      if (!targetId) {
        return;
      }
      onDebug?.({
        id: `${Date.now()}-client-account-rate-limits`,
        timestamp: Date.now(),
        source: "client",
        label: "account/rateLimits/read",
        payload: { workspaceId: targetId },
      });
      try {
        const response = await getAccountRateLimits(targetId);
        onDebug?.({
          id: `${Date.now()}-server-account-rate-limits`,
          timestamp: Date.now(),
          source: "server",
          label: "account/rateLimits/read response",
          payload: response,
        });
        const rateLimits =
          (response?.result?.rateLimits as Record<string, unknown> | undefined) ??
          (response?.result?.rate_limits as Record<string, unknown> | undefined) ??
          (response?.rateLimits as Record<string, unknown> | undefined) ??
          (response?.rate_limits as Record<string, unknown> | undefined);
        if (rateLimits) {
          dispatch({
            type: "setRateLimits",
            workspaceId: targetId,
            rateLimits: normalizeRateLimits(rateLimits),
          });
        }
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-account-rate-limits-error`,
          timestamp: Date.now(),
          source: "error",
          label: "account/rateLimits/read error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [activeWorkspaceId, onDebug],
  );

  const pushThreadErrorMessage = useCallback(
    (threadId: string, message: string) => {
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: message,
      });
      if (threadId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId, hasUnread: true });
      }
    },
    [activeThreadId],
  );

  const markProcessing = useCallback((threadId: string, isProcessing: boolean) => {
    dispatch({
      type: "markProcessing",
      threadId,
      isProcessing,
      timestamp: Date.now(),
    });
  }, []);

  const safeMessageActivity = useCallback(() => {
    try {
      void onMessageActivity?.();
    } catch {
      // Ignore refresh errors to avoid breaking the UI.
    }
  }, [onMessageActivity]);

  const handleItemUpdate = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      shouldMarkProcessing: boolean,
    ) => {
      dispatch({ type: "ensureThread", workspaceId, threadId });
      if (shouldMarkProcessing) {
        markProcessing(threadId, true);
      }
      const itemType = asString(item?.type ?? "");
      if (itemType === "enteredReviewMode") {
        dispatch({ type: "markReviewing", threadId, isReviewing: true });
      } else if (itemType === "exitedReviewMode") {
        dispatch({ type: "markReviewing", threadId, isReviewing: false });
        markProcessing(threadId, false);
      }
      const converted = buildConversationItem(item);
      if (converted) {
        dispatch({ type: "upsertItem", threadId, item: converted });
      }
      safeMessageActivity();
    },
    [markProcessing, safeMessageActivity],
  );

  const handleToolOutputDelta = useCallback(
    (threadId: string, itemId: string, delta: string) => {
      markProcessing(threadId, true);
      dispatch({ type: "appendToolOutput", threadId, itemId, delta });
      safeMessageActivity();
    },
    [markProcessing, safeMessageActivity],
  );

  const handleWorkspaceConnected = useCallback(
    (workspaceId: string) => {
      onWorkspaceConnected(workspaceId);
      void refreshAccountRateLimits(workspaceId);
    },
    [onWorkspaceConnected, refreshAccountRateLimits],
  );

  // Claude-native: Codex handlers kept for reference but not used
  const _handlers = useMemo(
    () => ({
      onWorkspaceConnected: handleWorkspaceConnected,
      onApprovalRequest: (approval: ApprovalRequest) => {
        dispatch({ type: "addApproval", approval });
      },
      onAppServerEvent: (event: AppServerEvent) => {
        const method = String(event.message?.method ?? "");
        const inferredSource =
          method === "codex/stderr" ? "stderr" : "event";
        onDebug?.({
          id: `${Date.now()}-server-event`,
          timestamp: Date.now(),
          source: inferredSource,
          label: method || "event",
          payload: event,
        });
      },
      onAgentMessageDelta: ({
        workspaceId,
        threadId,
        itemId,
        delta,
      }: {
        workspaceId: string;
        threadId: string;
        itemId: string;
        delta: string;
      }) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        markProcessing(threadId, true);
        dispatch({ type: "appendAgentDelta", threadId, itemId, delta });
      },
      onAgentMessageCompleted: ({
        workspaceId,
        threadId,
        itemId,
        text,
      }: {
        workspaceId: string;
        threadId: string;
        itemId: string;
        text: string;
      }) => {
        const timestamp = Date.now();
        dispatch({ type: "ensureThread", workspaceId, threadId });
        dispatch({ type: "completeAgentMessage", threadId, itemId, text });
        dispatch({
          type: "setLastAgentMessage",
          threadId,
          text,
          timestamp,
        });
        markProcessing(threadId, false);
        recordThreadActivity(workspaceId, threadId, timestamp);
        safeMessageActivity();
        if (threadId !== activeThreadId) {
          dispatch({ type: "markUnread", threadId, hasUnread: true });
        }
      },
      onItemStarted: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
      ) => {
        handleItemUpdate(workspaceId, threadId, item, true);
      },
      onItemCompleted: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
      ) => {
        handleItemUpdate(workspaceId, threadId, item, false);
      },
      onReasoningSummaryDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        dispatch({ type: "appendReasoningSummary", threadId, itemId, delta });
      },
      onReasoningTextDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        dispatch({ type: "appendReasoningContent", threadId, itemId, delta });
      },
      onCommandOutputDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        handleToolOutputDelta(threadId, itemId, delta);
      },
      onFileChangeOutputDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        handleToolOutputDelta(threadId, itemId, delta);
      },
      onTurnStarted: (workspaceId: string, threadId: string, turnId: string) => {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
        });
        markProcessing(threadId, true);
        dispatch({ type: "clearThreadPlan", threadId });
        if (turnId) {
          dispatch({ type: "setActiveTurnId", threadId, turnId });
        }
      },
      onTurnCompleted: (_workspaceId: string, threadId: string, _turnId: string) => {
        markProcessing(threadId, false);
        dispatch({ type: "setActiveTurnId", threadId, turnId: null });
      },
      onTurnPlanUpdated: (
        workspaceId: string,
        threadId: string,
        turnId: string,
        payload: { explanation: unknown; plan: unknown },
      ) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        const normalized = normalizePlanUpdate(
          turnId,
          payload.explanation,
          payload.plan,
        );
        dispatch({ type: "setThreadPlan", threadId, plan: normalized });
      },
      onThreadTokenUsageUpdated: (
        workspaceId: string,
        threadId: string,
        tokenUsage: Record<string, unknown>,
      ) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        dispatch({
          type: "setThreadTokenUsage",
          threadId,
          tokenUsage: normalizeTokenUsage(tokenUsage),
        });
      },
      onAccountRateLimitsUpdated: (
        workspaceId: string,
        rateLimits: Record<string, unknown>,
      ) => {
        dispatch({
          type: "setRateLimits",
          workspaceId,
          rateLimits: normalizeRateLimits(rateLimits),
        });
      },
      onTurnError: (
        workspaceId: string,
        threadId: string,
        _turnId: string,
        payload: { message: string; willRetry: boolean },
      ) => {
        if (payload.willRetry) {
          return;
        }
        dispatch({ type: "ensureThread", workspaceId, threadId });
        markProcessing(threadId, false);
        dispatch({ type: "markReviewing", threadId, isReviewing: false });
        dispatch({
          type: "setActiveTurnId",
          threadId,
          turnId: null,
        });
        const message = payload.message
          ? `Turn failed: ${payload.message}`
          : "Turn failed.";
        pushThreadErrorMessage(threadId, message);
        safeMessageActivity();
      },
    }),
    [
      activeThreadId,
      activeWorkspaceId,
      handleWorkspaceConnected,
      handleItemUpdate,
      handleToolOutputDelta,
      markProcessing,
      onDebug,
      recordThreadActivity,
      pushThreadErrorMessage,
      safeMessageActivity,
    ],
  );

  // Claude-native: Codex event handling disabled
  // useAppServerEvents(handlers);

  // Claude Agent SDK event handlers
  // Events have shape: { type, sessionId, workspaceId, timestamp, payload }
  const claudeHandlers = useMemo(
    () => ({
      onSessionStarted: (event: ClaudeSessionStartedEvent) => {
        onDebug?.({
          id: `${Date.now()}-claude-session-started`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/session/started",
          payload: event,
        });
        const pendingId = pendingSessionByWorkspace.current[event.workspaceId];
        if (pendingId && pendingId !== event.sessionId) {
          dispatch({
            type: "migrateThread",
            workspaceId: event.workspaceId,
            fromThreadId: pendingId,
            toThreadId: event.sessionId,
          });
          pendingSessionByWorkspace.current[event.workspaceId] = event.sessionId;
        } else {
          dispatch({ type: "ensureThread", workspaceId: event.workspaceId, threadId: event.sessionId });
        }
        dispatch({ type: "setActiveThreadId", workspaceId: event.workspaceId, threadId: event.sessionId });
        loadedThreads.current[event.sessionId] = true;
      },

      onSessionClosed: (event: ClaudeSessionClosedEvent) => {
        onDebug?.({
          id: `${Date.now()}-claude-session-closed`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/session/closed",
          payload: event,
        });
        markProcessing(event.sessionId, false);
      },

      onMessageDelta: (event: ClaudeMessageDeltaEvent) => {
        dispatch({ type: "ensureThread", workspaceId: event.workspaceId, threadId: event.sessionId });
        markProcessing(event.sessionId, true);
        // Extract text delta from the SDK event
        // The payload.event is a BetaRawMessageStreamEvent which may have delta content
        const sdkEvent = event.payload.event as {
          type?: string;
          delta?: { type?: string; text?: string };
          content_block?: { type?: string };
        };
        if (sdkEvent?.type === "message_start") {
          if (!streamingMessageIds.current[event.sessionId]) {
            const streamingId = event.payload.uuid
              ? `msg-${event.sessionId}-${event.payload.uuid}`
              : `msg-${event.sessionId}-${Date.now()}`;
            streamingMessageIds.current[event.sessionId] = streamingId;
          }
        }
        if (sdkEvent?.type === "content_block_start") {
          if (
            !streamingMessageIds.current[event.sessionId] &&
            sdkEvent.content_block?.type === "text"
          ) {
            const streamingId = event.payload.uuid
              ? `msg-${event.sessionId}-${event.payload.uuid}`
              : `msg-${event.sessionId}-${Date.now()}`;
            streamingMessageIds.current[event.sessionId] = streamingId;
          }
        }
        if (sdkEvent?.type === "content_block_delta" && sdkEvent?.delta?.type === "text_delta" && sdkEvent?.delta?.text) {
          if (!streamingMessageIds.current[event.sessionId]) {
            const streamingId = event.payload.uuid
              ? `msg-${event.sessionId}-${event.payload.uuid}`
              : `msg-${event.sessionId}-${Date.now()}`;
            streamingMessageIds.current[event.sessionId] = streamingId;
          }
          const streamingId = streamingMessageIds.current[event.sessionId]!;
          dispatch({
            type: "appendAgentDelta",
            threadId: event.sessionId,
            itemId: streamingId,
            delta: normalizeStreamingText(sdkEvent.delta.text),
          });
        }
        safeMessageActivity();
      },

      onMessageComplete: (event: ClaudeMessageCompleteEvent) => {
        const timestamp = Date.now();
        dispatch({ type: "ensureThread", workspaceId: event.workspaceId, threadId: event.sessionId });
        // Extract final text from the BetaMessage
        const betaMessage = event.payload.message as { content?: Array<Record<string, unknown>> };
        const textContent = betaMessage?.content?.find(
          (c) => (c as { type?: string }).type === "text",
        ) as { text?: unknown } | undefined;
        const text = typeof textContent?.text === "string" ? normalizeStreamingText(textContent.text) : "";
        const itemId =
          streamingMessageIds.current[event.sessionId]
          ?? (event.payload.uuid
            ? `msg-${event.sessionId}-${event.payload.uuid}`
            : `msg-${event.sessionId}-${Date.now()}`);
        if (text.trim()) {
          dispatch({ type: "completeAgentMessage", threadId: event.sessionId, itemId, text });
        }
        const contentBlocks = betaMessage?.content ?? [];
        contentBlocks.forEach((block) => {
          if ((block as { type?: string }).type === "tool_use") {
            const toolUseId =
              (block.id as string | undefined)
              ?? (block.tool_use_id as string | undefined)
              ?? (block.toolUseId as string | undefined);
            if (!toolUseId) {
              return;
            }
            const toolName =
              (block.name as string | undefined)
              ?? (block.tool_name as string | undefined)
              ?? "tool";
            const toolItem: ConversationItem = {
              id: `tool-${toolUseId}`,
              kind: "tool",
              toolType: toolName,
              title: toolName,
              detail: JSON.stringify(block.input ?? {}, null, 2),
              status: "running",
            };
            dispatch({ type: "upsertItem", threadId: event.sessionId, item: toolItem });
          }
          if ((block as { type?: string }).type === "tool_result") {
            const toolUseId =
              (block.tool_use_id as string | undefined)
              ?? (block.toolUseId as string | undefined);
            if (!toolUseId) {
              return;
            }
            const output =
              typeof block.output === "string"
                ? block.output
                : block.content
                  ? JSON.stringify(block.content, null, 2)
                  : JSON.stringify(block, null, 2);
            const toolItem: ConversationItem = {
              id: `tool-${toolUseId}`,
              kind: "tool",
              toolType: "tool",
              title: "tool",
              detail: "",
              status: "completed",
              output,
            };
            dispatch({ type: "upsertItem", threadId: event.sessionId, item: toolItem });
          }
        });
        delete streamingMessageIds.current[event.sessionId];
        if (text) {
          dispatch({
            type: "setLastAgentMessage",
            threadId: event.sessionId,
            text,
            timestamp,
          });
        }
        markProcessing(event.sessionId, false);
        recordThreadActivity(event.workspaceId, event.sessionId, timestamp);
        safeMessageActivity();
        if (event.sessionId !== activeThreadId) {
          dispatch({ type: "markUnread", threadId: event.sessionId, hasUnread: true });
        }
      },

      onToolStarted: (event: ClaudeToolStartedEvent) => {
        onDebug?.({
          id: `${Date.now()}-claude-tool-started`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/tool/started",
          payload: event,
        });
        markProcessing(event.sessionId, true);
        // Optionally show tool in conversation
        const toolItem: ConversationItem = {
          id: `tool-${event.payload.toolUseId}`,
          kind: "tool",
          toolType: event.payload.toolName,
          title: event.payload.toolName,
          detail: JSON.stringify(event.payload.input, null, 2),
          status: "running",
        };
        dispatch({ type: "upsertItem", threadId: event.sessionId, item: toolItem });
      },

      onToolProgress: (event: ClaudeToolProgressEvent) => {
        onDebug?.({
          id: `${Date.now()}-claude-tool-progress`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/tool/progress",
          payload: event,
        });
        markProcessing(event.sessionId, true);
        // Update tool item with elapsed time
        const toolItem: ConversationItem = {
          id: `tool-${event.payload.toolUseId}`,
          kind: "tool",
          toolType: event.payload.toolName,
          title: event.payload.toolName,
          detail: "",
          status: "running",
          elapsedSeconds: event.payload.elapsedSeconds,
        };
        dispatch({ type: "upsertItem", threadId: event.sessionId, item: toolItem });
      },

      onToolCompleted: (event: { sessionId: string; workspaceId: string; timestamp: number; payload: { toolName: string; toolUseId: string; output: unknown } }) => {
        onDebug?.({
          id: `${Date.now()}-claude-tool-completed`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/tool/completed",
          payload: event,
        });
        // Update tool status to completed
        const output = typeof event.payload.output === "string"
          ? event.payload.output
          : JSON.stringify(event.payload.output, null, 2);
        const toolItem: ConversationItem = {
          id: `tool-${event.payload.toolUseId}`,
          kind: "tool",
          toolType: event.payload.toolName,
          title: event.payload.toolName,
          detail: "",
          status: "completed",
          output,
        };
        dispatch({ type: "upsertItem", threadId: event.sessionId, item: toolItem });
      },

      onResult: (event: ClaudeResultEvent) => {
        onDebug?.({
          id: `${Date.now()}-claude-result`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/result",
          payload: event,
        });
        markProcessing(event.sessionId, false);
        dispatch({ type: "setActiveTurnId", threadId: event.sessionId, turnId: null });
        // Update token usage from result payload
        if (event.payload.usage) {
          dispatch({
            type: "setThreadTokenUsage",
            threadId: event.sessionId,
            tokenUsage: normalizeClaudeUsage(event.payload.usage),
          });
        }
        // Handle errors in result
        if (!event.payload.success && event.payload.errors?.length) {
          pushThreadErrorMessage(event.sessionId, `Error: ${event.payload.errors.join(", ")}`);
        }
        dispatch({ type: "completeRunningTools", threadId: event.sessionId });
        delete streamingMessageIds.current[event.sessionId];
      },

      onApprovalRequest: (request: ClaudeApprovalRequest) => {
        onDebug?.({
          id: `${Date.now()}-claude-permission-request`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/permission/request",
          payload: request,
        });
        dispatch({ type: "addApproval", approval: request });
      },

      onError: (event: ClaudeErrorEvent) => {
        onDebug?.({
          id: `${Date.now()}-claude-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/error",
          payload: event,
        });
        if (!event.payload.recoverable) {
          dispatch({ type: "ensureThread", workspaceId: event.workspaceId, threadId: event.sessionId });
          markProcessing(event.sessionId, false);
          dispatch({ type: "setActiveTurnId", threadId: event.sessionId, turnId: null });
          pushThreadErrorMessage(event.sessionId, `Error: ${event.payload.message}`);
          safeMessageActivity();
        }
      },

      onBridgeConnected: (workspaceId: string, payload: unknown) => {
        onDebug?.({
          id: `${Date.now()}-claude-bridge-connected`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/bridge/connected",
          payload: { workspaceId, payload },
        });
      },

      onBridgeStderr: (workspaceId: string, message: string) => {
        onDebug?.({
          id: `${Date.now()}-claude-bridge-stderr`,
          timestamp: Date.now(),
          source: "stderr",
          label: "claude/bridge/stderr",
          payload: { workspaceId, message },
        });
      },

      onRawEvent: (event: unknown) => {
        onDebug?.({
          id: `${Date.now()}-claude-raw-event`,
          timestamp: Date.now(),
          source: "event",
          label: "claude/raw",
          payload: event,
        });
      },
    }),
    [
      activeThreadId,
      markProcessing,
      onDebug,
      pushThreadErrorMessage,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  useClaudeEvents(claudeHandlers);

  // Claude-native: Codex functions kept for reference but not used
  const _startThreadForWorkspace = useCallback(
    async (workspaceId: string) => {
      onDebug?.({
        id: `${Date.now()}-client-thread-start`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/start",
        payload: { workspaceId },
      });
      try {
        const response = await startThreadService(workspaceId);
        onDebug?.({
          id: `${Date.now()}-server-thread-start`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/start response",
          payload: response,
        });
        const thread = response.result?.thread ?? response.thread;
        const threadId = String(thread?.id ?? "");
        if (threadId) {
          dispatch({ type: "ensureThread", workspaceId, threadId });
          dispatch({ type: "setActiveThreadId", workspaceId, threadId });
          loadedThreads.current[threadId] = true;
          return threadId;
        }
        return null;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [onDebug],
  );

  const _startThread = useCallback(async () => {
    if (!activeWorkspaceId) {
      return null;
    }
    return _startThreadForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, _startThreadForWorkspace]);

  const resumeThreadForWorkspace = useCallback(
    async (workspaceId: string, threadId: string, force = false) => {
      if (!threadId) {
        return null;
      }
      if (!force && loadedThreads.current[threadId]) {
        return threadId;
      }
      onDebug?.({
        id: `${Date.now()}-client-thread-resume`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/resume",
        payload: { workspaceId, threadId },
      });
      try {
        const response =
          (await resumeThreadService(workspaceId, threadId)) as
            | Record<string, unknown>
            | null;
        onDebug?.({
          id: `${Date.now()}-server-thread-resume`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/resume response",
          payload: response,
        });
        const result = (response?.result ?? response) as
          | Record<string, unknown>
          | null;
        const thread = (result?.thread ?? response?.thread ?? null) as
          | Record<string, unknown>
          | null;
        if (thread) {
          const items = buildItemsFromThread(thread);
          const localItems = state.itemsByThread[threadId] ?? [];
          const mergedItems =
            items.length > 0 ? mergeThreadItems(items, localItems) : localItems;
          if (mergedItems.length > 0) {
            dispatch({ type: "setThreadItems", threadId, items: mergedItems });
          }
          dispatch({
            type: "markReviewing",
            threadId,
            isReviewing: isReviewingFromThread(thread),
          });
          const preview = asString(thread?.preview ?? "");
          if (preview) {
            dispatch({
              type: "setThreadName",
              workspaceId,
              threadId,
              name: previewThreadName(preview, `Agent ${threadId.slice(0, 4)}`),
            });
          }
          const lastAgentMessage = [...mergedItems]
            .reverse()
            .find(
              (item) => item.kind === "message" && item.role === "assistant",
            ) as ConversationItem | undefined;
          const lastText =
            lastAgentMessage && lastAgentMessage.kind === "message"
              ? lastAgentMessage.text
              : preview;
          if (lastText) {
            dispatch({
              type: "setLastAgentMessage",
              threadId,
              text: lastText,
              timestamp: getThreadTimestamp(thread),
            });
          }
        }
        loadedThreads.current[threadId] = true;
        return threadId;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/resume error",
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [onDebug, state.itemsByThread],
  );

  const listThreadsForWorkspace = useCallback(
    async (workspace: WorkspaceInfo) => {
      dispatch({
        type: "setThreadListLoading",
        workspaceId: workspace.id,
        isLoading: true,
      });
      onDebug?.({
        id: `${Date.now()}-client-thread-list`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/list",
        payload: { workspaceId: workspace.id, path: workspace.path },
      });
      try {
        const matchingThreads: Record<string, unknown>[] = [];
        const targetCount = 20;
        const pageSize = 20;
        let cursor: string | null = null;
        do {
          const response =
            (await listThreadsService(
              workspace.id,
              cursor,
              pageSize,
            )) as Record<string, unknown>;
          onDebug?.({
            id: `${Date.now()}-server-thread-list`,
            timestamp: Date.now(),
            source: "server",
            label: "thread/list response",
            payload: response,
          });
          const result = (response.result ?? response) as Record<string, unknown>;
          const data = Array.isArray(result?.data)
            ? (result.data as Record<string, unknown>[])
            : [];
          const nextCursor =
            (result?.nextCursor ?? result?.next_cursor ?? null) as string | null;
          matchingThreads.push(
            ...data.filter(
              (thread) => String(thread?.cwd ?? "") === workspace.path,
            ),
          );
          cursor = nextCursor;
        } while (cursor && matchingThreads.length < targetCount);

        const uniqueById = new Map<string, Record<string, unknown>>();
        matchingThreads.forEach((thread) => {
          const id = String(thread?.id ?? "");
          if (id && !uniqueById.has(id)) {
            uniqueById.set(id, thread);
          }
        });
        const uniqueThreads = Array.from(uniqueById.values());
        const activityByThread = threadActivityRef.current[workspace.id] ?? {};
        uniqueThreads.sort((a, b) => {
          const aId = String(a?.id ?? "");
          const bId = String(b?.id ?? "");
          const aCreated = Number(a?.createdAt ?? a?.created_at ?? 0);
          const bCreated = Number(b?.createdAt ?? b?.created_at ?? 0);
          const aActivity = Math.max(activityByThread[aId] ?? 0, aCreated);
          const bActivity = Math.max(activityByThread[bId] ?? 0, bCreated);
          return bActivity - aActivity;
        });
        const summaries = uniqueThreads
          .slice(0, targetCount)
          .map((thread, index) => {
            const preview = asString(thread?.preview ?? "").trim();
            const fallbackName = `Agent ${index + 1}`;
            const name =
              preview.length > 0
                ? preview.length > 38
                  ? `${preview.slice(0, 38)}…`
                  : preview
                : fallbackName;
            return { id: String(thread?.id ?? ""), name };
          })
          .filter((entry) => entry.id);
        dispatch({
          type: "setThreads",
          workspaceId: workspace.id,
          threads: summaries,
        });
        uniqueThreads.forEach((thread) => {
          const threadId = String(thread?.id ?? "");
          const preview = asString(thread?.preview ?? "").trim();
          if (!threadId || !preview) {
            return;
          }
          dispatch({
            type: "setLastAgentMessage",
            threadId,
            text: preview,
            timestamp: getThreadTimestamp(thread),
          });
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-list-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/list error",
          payload: error instanceof Error ? error.message : String(error),
        });
      } finally {
        dispatch({
          type: "setThreadListLoading",
          workspaceId: workspace.id,
          isLoading: false,
        });
      }
    },
    [onDebug],
  );

  const _ensureThreadForActiveWorkspace = useCallback(async () => {
    if (!activeWorkspace) {
      return null;
    }
    let threadId = activeThreadId;
    if (!threadId) {
      threadId = await _startThreadForWorkspace(activeWorkspace.id);
      if (!threadId) {
        return null;
      }
    } else if (!loadedThreads.current[threadId]) {
      await resumeThreadForWorkspace(activeWorkspace.id, threadId);
    }
    return threadId;
  }, [activeWorkspace, activeThreadId, resumeThreadForWorkspace, _startThreadForWorkspace]);

  const sendUserMessage = useCallback(
    async (text: string, images: string[] = []) => {
      if (!activeWorkspace || (!text.trim() && images.length === 0)) {
        return;
      }
      const messageText = text.trim();
      const promptExpansion = expandCustomPromptText(messageText, customPrompts);
      if (promptExpansion && "error" in promptExpansion) {
        if (activeThreadId) {
          pushThreadErrorMessage(activeThreadId, promptExpansion.error);
          safeMessageActivity();
        } else {
          onDebug?.({
            id: `${Date.now()}-client-prompt-expand-error`,
            timestamp: Date.now(),
            source: "error",
            label: "prompt/expand error",
            payload: promptExpansion.error,
          });
        }
        return;
      }
      const finalText = promptExpansion?.expanded ?? messageText;
      const threadId = await _ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }
      recordThreadActivity(activeWorkspace.id, threadId);
      dispatch({
        type: "addUserMessage",
        workspaceId: activeWorkspace.id,
        threadId,
        text: finalText,
        images,
      });
      dispatch({
        type: "setThreadName",
        workspaceId: activeWorkspace.id,
        threadId,
        name: previewThreadName(finalText, `Agent ${threadId.slice(0, 4)}`),
      });
      markProcessing(threadId, true);
      safeMessageActivity();
      onDebug?.({
        id: `${Date.now()}-client-turn-start`,
        timestamp: Date.now(),
        source: "client",
        label: "turn/start",
        payload: {
          workspaceId: activeWorkspace.id,
          threadId,
          text: finalText,
          images,
          model,
          effort,
        },
      });
      try {
        const response =
          (await sendUserMessageService(
          activeWorkspace.id,
          threadId,
          finalText,
          { model, effort, accessMode, images },
          )) as Record<string, unknown>;
        onDebug?.({
          id: `${Date.now()}-server-turn-start`,
          timestamp: Date.now(),
          source: "server",
          label: "turn/start response",
          payload: response,
        });
        const rpcError = extractRpcErrorMessage(response);
        if (rpcError) {
          markProcessing(threadId, false);
          dispatch({ type: "setActiveTurnId", threadId, turnId: null });
          pushThreadErrorMessage(threadId, `Turn failed to start: ${rpcError}`);
          safeMessageActivity();
          return;
        }
        const result = (response?.result ?? response) as Record<string, unknown>;
        const turn = (result?.turn ?? response?.turn ?? null) as
          | Record<string, unknown>
          | null;
        const turnId = asString(turn?.id ?? "");
        if (!turnId) {
          markProcessing(threadId, false);
          dispatch({ type: "setActiveTurnId", threadId, turnId: null });
          pushThreadErrorMessage(threadId, "Turn failed to start.");
          safeMessageActivity();
          return;
        }
        dispatch({ type: "setActiveTurnId", threadId, turnId });
      } catch (error) {
        markProcessing(threadId, false);
        dispatch({ type: "setActiveTurnId", threadId, turnId: null });
        onDebug?.({
          id: `${Date.now()}-client-turn-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "turn/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      markProcessing,
      activeThreadId,
      effort,
      accessMode,
      customPrompts,
      model,
      onDebug,
      pushThreadErrorMessage,
      recordThreadActivity,
      _ensureThreadForActiveWorkspace,
      safeMessageActivity,
    ],
  );

  const interruptTurn = useCallback(async () => {
    if (!activeWorkspace || !activeThreadId) {
      return;
    }
    const activeTurnId = state.activeTurnIdByThread[activeThreadId] ?? null;
    if (!activeTurnId) {
      return;
    }
    markProcessing(activeThreadId, false);
    dispatch({ type: "setActiveTurnId", threadId: activeThreadId, turnId: null });
    dispatch({
      type: "addAssistantMessage",
      threadId: activeThreadId,
      text: "Session stopped.",
    });
    onDebug?.({
      id: `${Date.now()}-client-turn-interrupt`,
      timestamp: Date.now(),
      source: "client",
      label: "turn/interrupt",
      payload: {
        workspaceId: activeWorkspace.id,
        threadId: activeThreadId,
        turnId: activeTurnId,
      },
    });
    try {
      const response = await interruptTurnService(
        activeWorkspace.id,
        activeThreadId,
        activeTurnId,
      );
      onDebug?.({
        id: `${Date.now()}-server-turn-interrupt`,
        timestamp: Date.now(),
        source: "server",
        label: "turn/interrupt response",
        payload: response,
      });
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-turn-interrupt-error`,
        timestamp: Date.now(),
        source: "error",
        label: "turn/interrupt error",
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  }, [activeThreadId, activeWorkspace, markProcessing, onDebug, state.activeTurnIdByThread]);

  const startReview = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !text.trim()) {
        return;
      }
      const threadId = await _ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      const target = parseReviewTarget(text);
      markProcessing(threadId, true);
      dispatch({ type: "markReviewing", threadId, isReviewing: true });
      dispatch({
        type: "upsertItem",
        threadId,
        item: {
          id: `review-start-${threadId}-${Date.now()}`,
          kind: "review",
          state: "started",
          text: formatReviewLabel(target),
        },
      });
      safeMessageActivity();
      onDebug?.({
        id: `${Date.now()}-client-review-start`,
        timestamp: Date.now(),
        source: "client",
        label: "review/start",
        payload: {
          workspaceId: activeWorkspace.id,
          threadId,
          target,
        },
      });
      try {
        const response = await startReviewService(
          activeWorkspace.id,
          threadId,
          target,
          "inline",
        );
        onDebug?.({
          id: `${Date.now()}-server-review-start`,
          timestamp: Date.now(),
          source: "server",
          label: "review/start response",
          payload: response,
        });
        const rpcError = extractRpcErrorMessage(response);
        if (rpcError) {
          markProcessing(threadId, false);
          dispatch({ type: "markReviewing", threadId, isReviewing: false });
          dispatch({ type: "setActiveTurnId", threadId, turnId: null });
          pushThreadErrorMessage(threadId, `Review failed to start: ${rpcError}`);
          safeMessageActivity();
          return;
        }
      } catch (error) {
        markProcessing(threadId, false);
        dispatch({ type: "markReviewing", threadId, isReviewing: false });
        onDebug?.({
          id: `${Date.now()}-client-review-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "review/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      _ensureThreadForActiveWorkspace,
      markProcessing,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
    ],
  );

  const handleApprovalDecision = useCallback(
    async (
      request: ApprovalRequest | ClaudeApprovalRequest,
      decision: "accept" | "decline",
    ) => {
      // Check if this is a Claude approval request (has tool_use_id)
      if ("tool_use_id" in request && "session_id" in request) {
        // Handle Claude permission request
        // claudeRespondPermission args: sessionId, toolUseId, decision, message?
        await claudeRespondPermission(
          request.session_id,
          request.tool_use_id,
          decision === "accept" ? "allow" : "deny",
          decision === "decline" ? "User declined" : undefined,
        );
        dispatch({ type: "removeApproval", requestId: request.tool_use_id });
      } else {
        // Handle Codex approval request
        await respondToServerRequest(
          request.workspace_id,
          request.request_id,
          decision,
        );
        dispatch({ type: "removeApproval", requestId: request.request_id });
      }
    },
    [],
  );

  const removeThread = useCallback((workspaceId: string, threadId: string) => {
    dispatch({ type: "removeThread", workspaceId, threadId });
    (async () => {
      try {
        await archiveThreadService(workspaceId, threadId);
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-archive-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/archive error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [onDebug]);

  // ============================================================================
  // Claude Agent SDK Session Management Functions
  // ============================================================================

  /**
   * Create a new Claude session for the active workspace.
   */
  const startClaudeSession = useCallback(async (
    workspaceOverride?: { id: string; path: string }
  ) => {
    const targetWorkspace = workspaceOverride ?? activeWorkspace;
    const targetWorkspaceId = workspaceOverride?.id ?? activeWorkspaceId;
    if (!targetWorkspace || !targetWorkspaceId) {
      return null;
    }
    onDebug?.({
      id: `${Date.now()}-client-claude-session-create`,
      timestamp: Date.now(),
      source: "client",
      label: "claude/session/start",
      payload: { workspaceId: targetWorkspaceId, cwd: targetWorkspace.path, model },
    });
    try {
      const response = await claudeStartSession(targetWorkspaceId, targetWorkspace.path, {
        model: model ?? undefined,
        permissionMode,
      });
      onDebug?.({
        id: `${Date.now()}-server-claude-session-create`,
        timestamp: Date.now(),
        source: "server",
        label: "claude/session/start response",
        payload: response,
      });
      const pendingSessionId = response.result?.sessionId ?? null;
      if (pendingSessionId) {
        pendingSessionByWorkspace.current[targetWorkspaceId] = pendingSessionId;
        dispatch({ type: "ensureThread", workspaceId: targetWorkspaceId, threadId: pendingSessionId });
        dispatch({ type: "setActiveThreadId", workspaceId: targetWorkspaceId, threadId: pendingSessionId });
      }
      // Session will be reconciled via onSessionStarted event
      return pendingSessionId;
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-claude-session-create-error`,
        timestamp: Date.now(),
        source: "error",
        label: "claude/session/start error",
        payload: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, [activeWorkspaceId, activeWorkspace, model, onDebug, permissionMode]);

  /**
   * Resume an existing Claude session.
   */
  const loadClaudeHistory = useCallback(
    async (workspaceId: string, sessionId: string, force = false) => {
      const existingItems = state.itemsByThread[sessionId] ?? [];
      if (!force && existingItems.length > 0) {
        return;
      }
      try {
        const history = await getSessionHistory(sessionId);
        if (history.items.length > 0) {
          dispatch({
            type: "setThreadItems",
            threadId: sessionId,
            items: history.items,
          });
        }
        if (history.preview) {
          dispatch({
            type: "setThreadName",
            workspaceId,
            threadId: sessionId,
            name: previewThreadName(history.preview, `Agent ${sessionId.slice(0, 4)}`),
          });
          dispatch({
            type: "setLastAgentMessage",
            threadId: sessionId,
            text: history.preview,
            timestamp: history.lastActivity || Date.now(),
          });
        }
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-claude-session-history-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/session/history error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onDebug, state.itemsByThread],
  );

  /**
   * Resume an existing Claude session.
   */
  const resumeClaudeSession = useCallback(
    async (workspaceId: string, sessionId: string, force = false) => {
      if (!sessionId) {
        return null;
      }
      if (!force && loadedThreads.current[sessionId]) {
        return sessionId;
      }
      onDebug?.({
        id: `${Date.now()}-client-claude-session-resume`,
        timestamp: Date.now(),
        source: "client",
        label: "claude/session/resume",
        payload: { workspaceId, sessionId },
      });
      try {
        const response = await claudeResumeSession(workspaceId, sessionId);
        onDebug?.({
          id: `${Date.now()}-server-claude-session-resume`,
          timestamp: Date.now(),
          source: "server",
          label: "claude/session/resume response",
          payload: response,
        });
        await loadClaudeHistory(workspaceId, sessionId, true);
        loadedThreads.current[sessionId] = true;
        return sessionId;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-claude-session-resume-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/session/resume error",
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [onDebug],
  );

  const setActiveThreadId = useCallback(
    (threadId: string | null, workspaceId?: string) => {
      const targetId = workspaceId ?? activeWorkspaceId;
      if (!targetId) {
        return;
      }
      dispatch({ type: "setActiveThreadId", workspaceId: targetId, threadId });
      if (threadId) {
        void resumeClaudeSession(targetId, threadId, true);
        void loadClaudeHistory(targetId, threadId, false);
      }
    },
    [activeWorkspaceId, loadClaudeHistory, resumeClaudeSession],
  );

  /**
   * Send a message to a Claude session.
   */
  const sendClaudeMessage = useCallback(
    async (text: string, images: string[] = []) => {
      if (!activeWorkspace || (!text.trim() && images.length === 0)) {
        return;
      }
      const messageText = text.trim();

      // Ensure we have a session
      let sessionId = activeThreadId;
      if (!sessionId) {
        sessionId = await startClaudeSession();
        if (!sessionId) {
          return;
        }
      }

      const messageId = createMessageId();
      recordThreadActivity(activeWorkspace.id, sessionId);
      dispatch({
        type: "addUserMessage",
        workspaceId: activeWorkspace.id,
        threadId: sessionId,
        text: messageText,
        images,
        messageId,
      });
      dispatch({
        type: "setThreadName",
        workspaceId: activeWorkspace.id,
        threadId: sessionId,
        name: previewThreadName(messageText, `Agent ${sessionId.slice(0, 4)}`),
      });
      markProcessing(sessionId, true);
      safeMessageActivity();

      onDebug?.({
        id: `${Date.now()}-client-claude-message-send`,
        timestamp: Date.now(),
        source: "client",
        label: "claude/message/send",
        payload: {
          workspaceId: activeWorkspace.id,
          sessionId,
          text: messageText,
          images,
        },
      });

      try {
        // claudeSendMessage args: sessionId, workspaceId, message, images
        await claudeSendMessage(
          sessionId,
          activeWorkspace.id,
          messageText,
          images.length > 0 ? images : undefined,
          messageId,
        );
      } catch (error) {
        markProcessing(sessionId, false);
        onDebug?.({
          id: `${Date.now()}-client-claude-message-send-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/message/send error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      activeThreadId,
      markProcessing,
      onDebug,
      pushThreadErrorMessage,
      recordThreadActivity,
      safeMessageActivity,
      startClaudeSession,
    ],
  );

  /**
   * Interrupt the active Claude session.
   */
  const interruptClaudeSession = useCallback(async () => {
    if (!activeWorkspace || !activeThreadId) {
      return;
    }
    markProcessing(activeThreadId, false);
    dispatch({ type: "setActiveTurnId", threadId: activeThreadId, turnId: null });
    dispatch({
      type: "addAssistantMessage",
      threadId: activeThreadId,
      text: "Session interrupted.",
    });
    onDebug?.({
      id: `${Date.now()}-client-claude-session-interrupt`,
      timestamp: Date.now(),
      source: "client",
      label: "claude/session/interrupt",
      payload: {
        workspaceId: activeWorkspace.id,
        sessionId: activeThreadId,
      },
    });
    try {
      // claudeInterrupt only takes sessionId
      await claudeInterrupt(activeThreadId);
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-claude-session-interrupt-error`,
        timestamp: Date.now(),
        source: "error",
        label: "claude/session/interrupt error",
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  }, [activeThreadId, activeWorkspace, markProcessing, onDebug]);

  /**
   * List visible Claude sessions for a workspace (from registry).
   */
  const listClaudeSessions = useCallback(
    async (workspace: WorkspaceInfo) => {
      dispatch({
        type: "setThreadListLoading",
        workspaceId: workspace.id,
        isLoading: true,
      });
      onDebug?.({
        id: `${Date.now()}-client-claude-sessions-list`,
        timestamp: Date.now(),
        source: "client",
        label: "claude/sessions/list",
        payload: { workspaceId: workspace.id },
      });
      try {
        const sessions = await getVisibleSessions(workspace.id);
        onDebug?.({
          id: `${Date.now()}-server-claude-sessions-list`,
          timestamp: Date.now(),
          source: "server",
          label: "claude/sessions/list response",
          payload: sessions,
        });
        const summaries = sessions.map((session) => ({
          id: session.sessionId,
          name: session.preview || `Agent ${session.sessionId.slice(0, 4)}`,
          status: session.status,
        }));
        dispatch({
          type: "setThreads",
          workspaceId: workspace.id,
          threads: summaries,
        });
        // Update last agent messages for each session
        sessions.forEach((session) => {
          if (session.preview) {
            dispatch({
              type: "setLastAgentMessage",
              threadId: session.sessionId,
              text: session.preview,
              timestamp: session.lastActivity,
            });
          }
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-claude-sessions-list-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/sessions/list error",
          payload: error instanceof Error ? error.message : String(error),
        });
      } finally {
        dispatch({
          type: "setThreadListLoading",
          workspaceId: workspace.id,
          isLoading: false,
        });
      }
    },
    [onDebug],
  );

  /**
   * Archive a Claude session (removes from registry, keeps data on disk).
   */
  const archiveClaudeSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      dispatch({ type: "removeThread", workspaceId, threadId: sessionId });
      (async () => {
        try {
          await registryArchiveSession(workspaceId, sessionId);
        } catch (error) {
          onDebug?.({
            id: `${Date.now()}-client-claude-session-archive-error`,
            timestamp: Date.now(),
            source: "error",
            label: "claude/session/archive error",
            payload: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    [onDebug],
  );

  /**
   * Handle Claude permission request decisions.
   * Uses tool_use_id as the identifier (backend key for permission tracking).
   */
  const handleClaudeApprovalDecision = useCallback(
    async (request: ClaudeApprovalRequest, decision: "allow" | "deny") => {
      onDebug?.({
        id: `${Date.now()}-client-claude-permission-respond`,
        timestamp: Date.now(),
        source: "client",
        label: "claude/permission/respond",
        payload: { request, decision },
      });
      try {
        // claudeRespondPermission args: sessionId, toolUseId, decision, message?
        await claudeRespondPermission(
          request.session_id,
          request.tool_use_id,
          decision,
          decision === "deny" ? "User denied" : undefined,
        );
        // Use tool_use_id for removal since that's the unique identifier
        dispatch({ type: "removeApproval", requestId: request.tool_use_id });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-claude-permission-respond-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/permission/respond error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onDebug],
  );

  // Rewind state
  const [isRewinding, setIsRewinding] = useState(false);
  const [rewindResult, setRewindResult] = useState<RewindDiffResult | null>(null);

  /**
   * Rewind a Claude session to a specific message.
   * This restores file checkpoints and truncates conversation history.
   */
  const rewindToMessage = useCallback(
    async (itemId: string, itemIndex: number) => {
      if (!activeThreadId || isRewinding) return;
      setIsRewinding(true);
      setRewindResult(null);
      onDebug?.({
        id: `${Date.now()}-client-claude-rewind`,
        timestamp: Date.now(),
        source: "client",
        label: "claude/rewind",
        payload: { sessionId: activeThreadId, messageId: itemId, itemIndex },
      });
      try {
        const result = await claudeRewindToMessage(activeThreadId, itemId);
        onDebug?.({
          id: `${Date.now()}-server-claude-rewind`,
          timestamp: Date.now(),
          source: "server",
          label: "claude/rewind response",
          payload: result,
        });
        if (result.canRewind) {
          // Truncate items after the target index
          dispatch({
            type: "truncateItems",
            threadId: activeThreadId,
            afterIndex: itemIndex,
          });
          const insertions = result.insertions ?? 0;
          const deletions = result.deletions ?? 0;
          if (insertions > 0 || deletions > 0) {
            setRewindResult({
              filesChanged: result.filesChanged?.length ?? 0,
              additions: insertions,
              deletions,
            });
          }
        }
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-claude-rewind-error`,
          timestamp: Date.now(),
          source: "error",
          label: "claude/rewind error",
          payload: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsRewinding(false);
      }
    },
    [activeThreadId, isRewinding, onDebug],
  );

  const clearRewindResult = useCallback(() => {
    setRewindResult(null);
  }, []);

  useEffect(() => {
    if (activeWorkspace?.connected) {
      void refreshAccountRateLimits(activeWorkspace.id);
    }
  }, [activeWorkspace?.connected, activeWorkspace?.id, refreshAccountRateLimits]);

  // Legacy Codex paths kept for reference; mark as used to satisfy noUnusedLocals.
  void {
    _handlers,
    _startThread,
    listThreadsForWorkspace,
    sendUserMessage,
    interruptTurn,
    removeThread,
    handleClaudeApprovalDecision,
  };

  // Claude-native: Primary exports use Claude implementations
  // Codex functions are kept internally for reference but not exported
  return {
    activeThreadId,
    setActiveThreadId,
    activeItems,
    approvals: state.approvals,
    threadsByWorkspace: state.threadsByWorkspace,
    threadStatusById: state.threadStatusById,
    threadListLoadingByWorkspace: state.threadListLoadingByWorkspace,
    activeTurnIdByThread: state.activeTurnIdByThread,
    tokenUsageByThread: state.tokenUsageByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
    planByThread: state.planByThread,
    lastAgentMessageByThread: state.lastAgentMessageByThread,
    refreshAccountRateLimits,
    // Primary thread lifecycle functions → routed to Claude
    interruptTurn: interruptClaudeSession,
    removeThread: archiveClaudeSession,
    startThread: startClaudeSession,
    startThreadForWorkspace: async (workspaceId: string, workspacePath?: string) => {
      if (workspacePath) {
        return startClaudeSession({ id: workspaceId, path: workspacePath });
      }
      return startClaudeSession();
    },
    listThreadsForWorkspace: listClaudeSessions,
    listClaudeSessions, // Alias for App.tsx compatibility
    sendUserMessage: sendClaudeMessage,
    startReview, // Keep Codex review for now (no Claude equivalent yet)
    handleApprovalDecision,
    // Rewind functionality (Phase 3)
    isRewinding,
    rewindResult,
    rewindToMessage,
    clearRewindResult,
  };
}
