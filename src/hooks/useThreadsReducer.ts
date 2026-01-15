import type {
  ApprovalRequest,
  ClaudeApprovalRequest,
  ConversationItem,
  RateLimitSnapshot,
  ThreadSummary,
  ThreadTokenUsage,
  TurnPlan,
} from "../types";

// Unified approval type that supports both Codex and Claude requests
export type UnifiedApprovalRequest = ApprovalRequest | ClaudeApprovalRequest;

// Type guard to check if it's a Claude approval request
export function isClaudeApproval(
  approval: UnifiedApprovalRequest,
): approval is ClaudeApprovalRequest {
  return "tool_use_id" in approval && "session_id" in approval;
}

// Get a unique ID for an approval request (works for both types)
// For Claude: uses tool_use_id (the identifier used by the backend)
// For Codex: uses request_id
export function getApprovalId(approval: UnifiedApprovalRequest): string | number {
  if (isClaudeApproval(approval)) {
    return approval.tool_use_id;
  }
  return approval.request_id;
}
import { normalizeItem, prepareThreadItems, upsertItem } from "../utils/threadItems";

type ThreadActivityStatus = {
  isProcessing: boolean;
  hasUnread: boolean;
  isReviewing: boolean;
  processingStartedAt: number | null;
  lastDurationMs: number | null;
};

export type ThreadState = {
  activeThreadIdByWorkspace: Record<string, string | null>;
  itemsByThread: Record<string, ConversationItem[]>;
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  threadStatusById: Record<string, ThreadActivityStatus>;
  threadListLoadingByWorkspace: Record<string, boolean>;
  activeTurnIdByThread: Record<string, string | null>;
  approvals: UnifiedApprovalRequest[];
  tokenUsageByThread: Record<string, ThreadTokenUsage>;
  rateLimitsByWorkspace: Record<string, RateLimitSnapshot | null>;
  planByThread: Record<string, TurnPlan | null>;
  lastAgentMessageByThread: Record<string, { text: string; timestamp: number }>;
};

export type ThreadAction =
  | { type: "setActiveThreadId"; workspaceId: string; threadId: string | null }
  | { type: "ensureThread"; workspaceId: string; threadId: string }
  | { type: "removeThread"; workspaceId: string; threadId: string }
  | {
      type: "markProcessing";
      threadId: string;
      isProcessing: boolean;
      timestamp: number;
    }
  | { type: "markReviewing"; threadId: string; isReviewing: boolean }
  | { type: "markUnread"; threadId: string; hasUnread: boolean }
  | {
      type: "addUserMessage";
      workspaceId: string;
      threadId: string;
      text: string;
      images?: string[];
      messageId?: string;
    }
  | { type: "addAssistantMessage"; threadId: string; text: string }
  | { type: "setThreadName"; workspaceId: string; threadId: string; name: string }
  | { type: "appendAgentDelta"; threadId: string; itemId: string; delta: string }
  | { type: "completeAgentMessage"; threadId: string; itemId: string; text: string }
  | { type: "completeRunningTools"; threadId: string }
  | { type: "migrateThread"; workspaceId: string; fromThreadId: string; toThreadId: string }
  | { type: "upsertItem"; threadId: string; item: ConversationItem }
  | { type: "setThreadItems"; threadId: string; items: ConversationItem[] }
  | {
      type: "appendReasoningSummary";
      threadId: string;
      itemId: string;
      delta: string;
    }
  | { type: "appendReasoningContent"; threadId: string; itemId: string; delta: string }
  | { type: "appendToolOutput"; threadId: string; itemId: string; delta: string }
  | { type: "setThreads"; workspaceId: string; threads: ThreadSummary[] }
  | {
      type: "setThreadListLoading";
      workspaceId: string;
      isLoading: boolean;
    }
  | { type: "addApproval"; approval: UnifiedApprovalRequest }
  | { type: "removeApproval"; requestId: number | string }
  | { type: "setThreadTokenUsage"; threadId: string; tokenUsage: ThreadTokenUsage }
  | {
      type: "setRateLimits";
      workspaceId: string;
      rateLimits: RateLimitSnapshot | null;
    }
  | { type: "setActiveTurnId"; threadId: string; turnId: string | null }
  | { type: "setThreadPlan"; threadId: string; plan: TurnPlan | null }
  | { type: "clearThreadPlan"; threadId: string }
  | {
      type: "setLastAgentMessage";
      threadId: string;
      text: string;
      timestamp: number;
    }
  | { type: "truncateItems"; threadId: string; afterIndex: number };

const emptyItems: Record<string, ConversationItem[]> = {};

export const initialState: ThreadState = {
  activeThreadIdByWorkspace: {},
  itemsByThread: emptyItems,
  threadsByWorkspace: {},
  threadStatusById: {},
  threadListLoadingByWorkspace: {},
  activeTurnIdByThread: {},
  approvals: [],
  tokenUsageByThread: {},
  rateLimitsByWorkspace: {},
  planByThread: {},
  lastAgentMessageByThread: {},
};

function mergeStreamingText(existing: string, delta: string) {
  if (!delta) {
    return existing;
  }
  if (!existing) {
    return delta;
  }
  if (delta === existing) {
    return existing;
  }
  if (delta.startsWith(existing)) {
    return delta;
  }
  if (existing.startsWith(delta)) {
    return existing;
  }
  const maxOverlap = Math.min(existing.length, delta.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (existing.endsWith(delta.slice(0, length))) {
      return `${existing}${delta.slice(length)}`;
    }
  }
  return `${existing}${delta}`;
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case "setActiveThreadId":
      return {
        ...state,
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]: action.threadId,
        },
        threadStatusById: action.threadId
          ? {
              ...state.threadStatusById,
              [action.threadId]: {
                isProcessing:
                  state.threadStatusById[action.threadId]?.isProcessing ?? false,
                hasUnread: false,
                isReviewing:
                  state.threadStatusById[action.threadId]?.isReviewing ?? false,
                processingStartedAt:
                  state.threadStatusById[action.threadId]?.processingStartedAt ??
                  null,
                lastDurationMs:
                  state.threadStatusById[action.threadId]?.lastDurationMs ?? null,
              },
            }
          : state.threadStatusById,
      };
    case "ensureThread": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      if (list.some((thread) => thread.id === action.threadId)) {
        return state;
      }
      const thread: ThreadSummary = {
        id: action.threadId,
        name: `Agent ${list.length + 1}`,
      };
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: [thread, ...list],
        },
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing: false,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: null,
            lastDurationMs: null,
          },
        },
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]:
            state.activeThreadIdByWorkspace[action.workspaceId] ?? action.threadId,
        },
      };
    }
    case "removeThread": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      const filtered = list.filter((thread) => thread.id !== action.threadId);
      const nextActive =
        state.activeThreadIdByWorkspace[action.workspaceId] === action.threadId
          ? filtered[0]?.id ?? null
          : state.activeThreadIdByWorkspace[action.workspaceId] ?? null;
      const { [action.threadId]: _, ...restItems } = state.itemsByThread;
      const { [action.threadId]: __, ...restStatus } = state.threadStatusById;
      const { [action.threadId]: ___, ...restTurns } = state.activeTurnIdByThread;
      const { [action.threadId]: ____, ...restPlans } = state.planByThread;
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: filtered,
        },
        itemsByThread: restItems,
        threadStatusById: restStatus,
        activeTurnIdByThread: restTurns,
        planByThread: restPlans,
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]: nextActive,
        },
      };
    }
    case "markProcessing": {
      const previous = state.threadStatusById[action.threadId];
      const wasProcessing = previous?.isProcessing ?? false;
      const startedAt = previous?.processingStartedAt ?? null;
      const lastDurationMs = previous?.lastDurationMs ?? null;
      if (action.isProcessing) {
        return {
          ...state,
          threadStatusById: {
            ...state.threadStatusById,
            [action.threadId]: {
              isProcessing: true,
              hasUnread: previous?.hasUnread ?? false,
              isReviewing: previous?.isReviewing ?? false,
              processingStartedAt:
                wasProcessing && startedAt ? startedAt : action.timestamp,
              lastDurationMs,
            },
          },
        };
      }
      const nextDuration =
        wasProcessing && startedAt
          ? Math.max(0, action.timestamp - startedAt)
          : lastDurationMs ?? null;
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing: false,
            hasUnread: previous?.hasUnread ?? false,
            isReviewing: previous?.isReviewing ?? false,
            processingStartedAt: null,
            lastDurationMs: nextDuration,
          },
        },
      };
    }
    case "setActiveTurnId":
      return {
        ...state,
        activeTurnIdByThread: {
          ...state.activeTurnIdByThread,
          [action.threadId]: action.turnId,
        },
      };
    case "markReviewing":
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing:
              state.threadStatusById[action.threadId]?.isProcessing ?? false,
            hasUnread: state.threadStatusById[action.threadId]?.hasUnread ?? false,
            isReviewing: action.isReviewing,
            processingStartedAt:
              state.threadStatusById[action.threadId]?.processingStartedAt ?? null,
            lastDurationMs:
              state.threadStatusById[action.threadId]?.lastDurationMs ?? null,
          },
        },
      };
    case "markUnread":
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing:
              state.threadStatusById[action.threadId]?.isProcessing ?? false,
            hasUnread: action.hasUnread,
            isReviewing:
              state.threadStatusById[action.threadId]?.isReviewing ?? false,
            processingStartedAt:
              state.threadStatusById[action.threadId]?.processingStartedAt ?? null,
            lastDurationMs:
              state.threadStatusById[action.threadId]?.lastDurationMs ?? null,
          },
        },
      };
    case "addUserMessage": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const imageCount = action.images?.length ?? 0;
      const imageLabel =
        imageCount > 0 ? (imageCount === 1 ? "[image]" : `[image x${imageCount}]`) : "";
      const textValue = action.text.trim();
      const combinedText = textValue
        ? imageLabel
          ? `${textValue}\n${imageLabel}`
          : textValue
        : imageLabel;
      const message: ConversationItem = {
        id: action.messageId ?? `${Date.now()}-user`,
        kind: "message",
        role: "user",
        text: combinedText || "[message]",
      };
      const threads = state.threadsByWorkspace[action.workspaceId] ?? [];
      const bumpedThreads = threads.length
        ? [
            ...threads.filter((thread) => thread.id === action.threadId),
            ...threads.filter((thread) => thread.id !== action.threadId),
          ]
        : threads;
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems([...list, message]),
        },
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: bumpedThreads,
        },
      };
    }
    case "addAssistantMessage": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const message: ConversationItem = {
        id: `${Date.now()}-assistant`,
        kind: "message",
        role: "assistant",
        text: action.text,
      };
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems([...list, message]),
        },
      };
    }
    case "setThreadName": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      const next = list.map((thread) =>
        thread.id === action.threadId ? { ...thread, name: action.name } : thread,
      );
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: next,
        },
      };
    }
    case "appendAgentDelta": {
      const list = [...(state.itemsByThread[action.threadId] ?? [])];
      const index = list.findIndex((msg) => msg.id === action.itemId);
      if (index >= 0 && list[index].kind === "message") {
        const existing = list[index];
        list[index] = {
          ...existing,
          text: mergeStreamingText(existing.text, action.delta),
        };
      } else {
        list.push({
          id: action.itemId,
          kind: "message",
          role: "assistant",
          text: action.delta,
        });
      }
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(list),
        },
      };
    }
    case "completeAgentMessage": {
      const list = [...(state.itemsByThread[action.threadId] ?? [])];
      const index = list.findIndex((msg) => msg.id === action.itemId);
      if (index >= 0 && list[index].kind === "message") {
        const existing = list[index];
        list[index] = {
          ...existing,
          text: action.text || existing.text,
        };
      } else {
        list.push({
          id: action.itemId,
          kind: "message",
          role: "assistant",
          text: action.text,
        });
      }
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(list),
        },
      };
    }
    case "completeRunningTools": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const next = list.map((item) => {
        if (item.kind !== "tool" || item.status !== "running") {
          return item;
        }
        return {
          ...item,
          status: "completed",
        };
      });
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(next),
        },
      };
    }
    case "migrateThread": {
      if (action.fromThreadId === action.toThreadId) {
        return state;
      }
      const items = state.itemsByThread[action.fromThreadId] ?? [];
      const threads = state.threadsByWorkspace[action.workspaceId] ?? [];
      const updatedThreads = threads.map((thread) =>
        thread.id === action.fromThreadId ? { ...thread, id: action.toThreadId } : thread,
      );
      const nextItemsByThread = { ...state.itemsByThread };
      delete nextItemsByThread[action.fromThreadId];
      nextItemsByThread[action.toThreadId] = items;

      const nextThreadStatusById = { ...state.threadStatusById };
      if (state.threadStatusById[action.fromThreadId]) {
        nextThreadStatusById[action.toThreadId] =
          state.threadStatusById[action.fromThreadId];
        delete nextThreadStatusById[action.fromThreadId];
      }

      const nextActiveTurnIdByThread = { ...state.activeTurnIdByThread };
      if (state.activeTurnIdByThread[action.fromThreadId]) {
        nextActiveTurnIdByThread[action.toThreadId] =
          state.activeTurnIdByThread[action.fromThreadId];
        delete nextActiveTurnIdByThread[action.fromThreadId];
      }

      const nextTokenUsageByThread = { ...state.tokenUsageByThread };
      if (state.tokenUsageByThread[action.fromThreadId]) {
        nextTokenUsageByThread[action.toThreadId] =
          state.tokenUsageByThread[action.fromThreadId];
        delete nextTokenUsageByThread[action.fromThreadId];
      }

      const nextPlanByThread = { ...state.planByThread };
      if (state.planByThread[action.fromThreadId]) {
        nextPlanByThread[action.toThreadId] = state.planByThread[action.fromThreadId];
        delete nextPlanByThread[action.fromThreadId];
      }

      const nextLastAgentMessage = { ...state.lastAgentMessageByThread };
      if (state.lastAgentMessageByThread[action.fromThreadId]) {
        nextLastAgentMessage[action.toThreadId] =
          state.lastAgentMessageByThread[action.fromThreadId];
        delete nextLastAgentMessage[action.fromThreadId];
      }

      const nextActiveByWorkspace = {
        ...state.activeThreadIdByWorkspace,
        [action.workspaceId]:
          state.activeThreadIdByWorkspace[action.workspaceId] === action.fromThreadId
            ? action.toThreadId
            : state.activeThreadIdByWorkspace[action.workspaceId],
      };

      return {
        ...state,
        itemsByThread: nextItemsByThread,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: updatedThreads,
        },
        threadStatusById: nextThreadStatusById,
        activeTurnIdByThread: nextActiveTurnIdByThread,
        tokenUsageByThread: nextTokenUsageByThread,
        planByThread: nextPlanByThread,
        lastAgentMessageByThread: nextLastAgentMessage,
        activeThreadIdByWorkspace: nextActiveByWorkspace,
      };
    }
    case "upsertItem": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const item = normalizeItem(action.item);
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(upsertItem(list, item)),
        },
      };
    }
    case "setThreadItems":
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(action.items),
        },
      };
    case "setLastAgentMessage":
      if (
        state.lastAgentMessageByThread[action.threadId]?.timestamp >= action.timestamp
      ) {
        return state;
      }
      return {
        ...state,
        lastAgentMessageByThread: {
          ...state.lastAgentMessageByThread,
          [action.threadId]: { text: action.text, timestamp: action.timestamp },
        },
      };
    case "appendReasoningSummary": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const index = list.findIndex((entry) => entry.id === action.itemId);
      const base =
        index >= 0 && list[index].kind === "reasoning"
          ? (list[index] as ConversationItem)
          : {
              id: action.itemId,
              kind: "reasoning",
              summary: "",
              content: "",
            };
      const updated: ConversationItem = {
        ...base,
        summary: mergeStreamingText(
          "summary" in base ? base.summary : "",
          action.delta,
        ),
      } as ConversationItem;
      const next = index >= 0 ? [...list] : [...list, updated];
      if (index >= 0) {
        next[index] = updated;
      }
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(next),
        },
      };
    }
    case "appendReasoningContent": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const index = list.findIndex((entry) => entry.id === action.itemId);
      const base =
        index >= 0 && list[index].kind === "reasoning"
          ? (list[index] as ConversationItem)
          : {
              id: action.itemId,
              kind: "reasoning",
              summary: "",
              content: "",
            };
      const updated: ConversationItem = {
        ...base,
        content: mergeStreamingText(
          "content" in base ? base.content : "",
          action.delta,
        ),
      } as ConversationItem;
      const next = index >= 0 ? [...list] : [...list, updated];
      if (index >= 0) {
        next[index] = updated;
      }
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(next),
        },
      };
    }
    case "appendToolOutput": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const index = list.findIndex((entry) => entry.id === action.itemId);
      if (index < 0 || list[index].kind !== "tool") {
        return state;
      }
      const existing = list[index];
      const updated: ConversationItem = {
        ...existing,
        output: mergeStreamingText(existing.output ?? "", action.delta),
      } as ConversationItem;
      const next = [...list];
      next[index] = updated;
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: prepareThreadItems(next),
        },
      };
    }
    case "addApproval":
      return { ...state, approvals: [...state.approvals, action.approval] };
    case "removeApproval":
      return {
        ...state,
        approvals: state.approvals.filter(
          (item) => getApprovalId(item) !== action.requestId,
        ),
      };
    case "setThreads": {
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: action.threads,
        },
      };
    }
    case "setThreadListLoading":
      return {
        ...state,
        threadListLoadingByWorkspace: {
          ...state.threadListLoadingByWorkspace,
          [action.workspaceId]: action.isLoading,
        },
      };
    case "setThreadTokenUsage":
      return {
        ...state,
        tokenUsageByThread: {
          ...state.tokenUsageByThread,
          [action.threadId]: action.tokenUsage,
        },
      };
    case "setRateLimits":
      return {
        ...state,
        rateLimitsByWorkspace: {
          ...state.rateLimitsByWorkspace,
          [action.workspaceId]: action.rateLimits,
        },
      };
    case "setThreadPlan":
      return {
        ...state,
        planByThread: {
          ...state.planByThread,
          [action.threadId]: action.plan,
        },
      };
    case "clearThreadPlan":
      return {
        ...state,
        planByThread: {
          ...state.planByThread,
          [action.threadId]: null,
        },
      };
    case "truncateItems": {
      const list = state.itemsByThread[action.threadId] ?? [];
      // Keep items up to and including the target index
      const truncated = list.slice(0, action.afterIndex + 1);
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: truncated,
        },
      };
    }
    default:
      return state;
  }
}
