# Legacy Codex Architecture Documentation

This document captures the architecture and patterns of the original Codex integration in CodexMonitor. It serves as a reference for understanding how Codex worked and provides guidance for achieving feature parity in the Claude-native implementation.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Layers](#architecture-layers)
3. [App-Server Protocol](#app-server-protocol)
4. [Thread Lifecycle](#thread-lifecycle)
5. [Event System](#event-system)
6. [Approval Request Flow](#approval-request-flow)
7. [UI State Management](#ui-state-management)
8. [File Reference](#file-reference)
9. [Feature Parity Checklist](#feature-parity-checklist)
10. [Strengths and Limitations](#strengths-and-limitations)

---

## Overview

CodexMonitor originally used OpenAI's Codex CLI as its AI backend. The integration consisted of:

- **Rust Backend**: Spawned and managed `codex app-server` processes via Tauri IPC
- **JSON-RPC Protocol**: Communicated with Codex using a bidirectional JSONL protocol
- **Event-Driven UI**: Tauri events bridged backend events to the React frontend
- **Reducer-Based State**: Thread/conversation state managed via React reducer

### Key Concept: Workspace Sessions

Each workspace had its own Codex `app-server` process. When a user connected a workspace, CodexMonitor:

1. Validated the Codex CLI installation (`codex --version`)
2. Spawned `codex app-server` in the workspace directory
3. Sent `initialize` request and waited for response
4. Emitted `codex/connected` event to signal ready state

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                        React Frontend                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │   App.tsx    │  │ useThreads.ts│  │ useAppServerEvents.ts  │ │
│  │  (composer)  │  │  (reducer)   │  │   (event listener)     │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
│                            │                    ↑               │
│                            │                    │               │
│                     Tauri IPC (invoke)    Tauri Events          │
└─────────────────────────────────────────────────────────────────┘
                             │                    │
                             ↓                    ↑
┌─────────────────────────────────────────────────────────────────┐
│                      Rust Backend (Tauri)                       │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │    lib.rs        │    │          codex.rs                │   │
│  │  (command reg)   │    │  (WorkspaceSession, IPC logic)   │   │
│  └──────────────────┘    └──────────────────────────────────┘   │
│                                     │                           │
│                              stdin/stdout                       │
└─────────────────────────────────────────────────────────────────┘
                                     │
                                     ↓
┌─────────────────────────────────────────────────────────────────┐
│                      codex app-server                           │
│               (External CLI process per workspace)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## App-Server Protocol

The Codex app-server communicates via **JSONL** (JSON Lines) over stdin/stdout. The protocol follows JSON-RPC 2.0 conventions.

### Request/Response Pattern

**Client → Server (Request):**
```json
{"id": 1, "method": "thread/start", "params": {"cwd": "/path/to/project", "approvalPolicy": "on-request"}}
```

**Server → Client (Response):**
```json
{"id": 1, "result": {"thread": {"id": "thread-uuid", "createdAt": 1234567890}}}
```

### Notification Pattern

**Server → Client (Event):**
```json
{"method": "item/agentMessage/delta", "params": {"threadId": "...", "itemId": "...", "delta": "Hello"}}
```

### Core Methods

| Method | Direction | Description |
|--------|-----------|-------------|
| `initialize` | → | Handshake with client info |
| `initialized` | → | Confirm initialization complete |
| `thread/start` | → | Create new conversation thread |
| `thread/resume` | → | Load existing thread |
| `thread/list` | → | Paginated thread listing |
| `thread/archive` | → | Archive (hide) a thread |
| `turn/start` | → | Send user message, start turn |
| `turn/interrupt` | → | Stop active turn |
| `review/start` | → | Start code review mode |
| `model/list` | → | List available models |
| `account/rateLimits/read` | → | Get rate limit info |
| `skills/list` | → | List available skills |

### Server Events (Notifications)

| Method | Description |
|--------|-------------|
| `codex/connected` | Workspace ready (synthetic, emitted by backend) |
| `codex/stderr` | Stderr output from app-server |
| `codex/parseError` | Failed to parse server line |
| `turn/started` | Turn processing began |
| `turn/completed` | Turn processing finished |
| `turn/plan/updated` | Plan steps updated |
| `turn/diff/updated` | Diff output updated |
| `error` | Turn error occurred |
| `item/started` | Item (tool, reasoning) started |
| `item/completed` | Item completed |
| `item/agentMessage/delta` | Streaming text chunk |
| `item/reasoning/summaryTextDelta` | Reasoning summary chunk |
| `item/reasoning/textDelta` | Reasoning content chunk |
| `item/commandExecution/outputDelta` | Command output chunk |
| `item/fileChange/outputDelta` | File change output chunk |
| `thread/tokenUsage/updated` | Token usage updated |
| `account/rateLimits/updated` | Rate limits updated |
| `*requestApproval*` | Permission request (contains `requestApproval` in method name) |

---

## Thread Lifecycle

### State Machine

```
                    ┌──────────────────┐
                    │   No Thread      │
                    └────────┬─────────┘
                             │ thread/start
                             ↓
                    ┌──────────────────┐
        ┌──────────→│   Thread Ready   │←──────────┐
        │           └────────┬─────────┘           │
        │                    │ turn/start          │
        │                    ↓                     │
        │           ┌──────────────────┐           │
        │           │   Processing     │───────────┤ turn/completed
        │           │   (isProcessing) │           │
        │           └────────┬─────────┘           │
        │                    │ turn/interrupt      │
        │                    ↓                     │
        │           ┌──────────────────┐           │
        └───────────│   Interrupted    │───────────┘
                    └──────────────────┘
```

### Thread Data Flow

1. **Creation**: `startThreadService(workspaceId)` → `thread/start` RPC
2. **Resumption**: `resumeThreadService(workspaceId, threadId)` → `thread/resume` RPC
3. **Listing**: `listThreadsService(workspaceId, cursor, limit)` → `thread/list` RPC
4. **Archiving**: `archiveThreadService(workspaceId, threadId)` → `thread/archive` RPC

### Turn Processing

A "turn" represents one user→assistant interaction cycle:

```typescript
// 1. Send message
await sendUserMessageService(workspaceId, threadId, text, { model, effort, accessMode, images });

// 2. Backend sends turn/start RPC
// 3. Events stream in: item/started, item/agentMessage/delta, etc.
// 4. turn/completed event signals end

// To interrupt:
await interruptTurnService(workspaceId, threadId, turnId);
```

---

## Event System

### Tauri Event Flow

```
codex app-server (stdout)
        │
        ↓ parse JSON line
┌───────────────────────────────────────┐
│     Rust: spawn_workspace_session     │
│  - If has `id` + `result/error`:      │
│    resolve pending request            │
│  - If has `method`:                   │
│    emit "app-server-event"            │
└───────────────────────────────────────┘
        │
        ↓ Tauri event
┌───────────────────────────────────────┐
│    React: useAppServerEvents hook     │
│  - Dispatch to appropriate handler    │
│  - Update reducer state               │
└───────────────────────────────────────┘
```

### Event Payload Structure

All events are wrapped in `AppServerEvent`:

```typescript
type AppServerEvent = {
  workspace_id: string;
  message: Record<string, unknown>;  // Contains `method` and `params`
};
```

### Handler Registration

```typescript
useAppServerEvents({
  onWorkspaceConnected: (workspaceId) => { /* ... */ },
  onApprovalRequest: (request) => { /* ... */ },
  onAgentMessageDelta: ({ workspaceId, threadId, itemId, delta }) => { /* ... */ },
  onAgentMessageCompleted: ({ workspaceId, threadId, itemId, text }) => { /* ... */ },
  onTurnStarted: (workspaceId, threadId, turnId) => { /* ... */ },
  onTurnCompleted: (workspaceId, threadId, turnId) => { /* ... */ },
  onTurnError: (workspaceId, threadId, turnId, payload) => { /* ... */ },
  onItemStarted: (workspaceId, threadId, item) => { /* ... */ },
  onItemCompleted: (workspaceId, threadId, item) => { /* ... */ },
  // ... more handlers
});
```

---

## Approval Request Flow

### Permission Request Lifecycle

```
                    ┌──────────────────────────────┐
                    │    Tool wants to execute     │
                    │    (file write, command)     │
                    └──────────────┬───────────────┘
                                   │
                                   ↓
                    ┌──────────────────────────────┐
                    │  Server sends RPC request    │
                    │  with `id` and method        │
                    │  containing "requestApproval"│
                    └──────────────┬───────────────┘
                                   │
                                   ↓
┌──────────────────────────────────────────────────────────────────┐
│                         Frontend                                  │
│  1. useAppServerEvents detects requestApproval in method         │
│  2. Dispatches addApproval to reducer                            │
│  3. ApprovalToasts component renders toast                       │
│  4. User clicks Accept/Decline                                   │
│  5. handleApprovalDecision sends response                        │
│  6. Dispatches removeApproval to clear toast                     │
└──────────────────────────────────────────────────────────────────┘
                                   │
                                   ↓
                    ┌──────────────────────────────┐
                    │  respondToServerRequest      │
                    │  sends JSON-RPC response     │
                    │  with matching `id`          │
                    └──────────────────────────────┘
```

### Approval Request Structure

```typescript
type ApprovalRequest = {
  workspace_id: string;
  request_id: number;       // JSON-RPC request ID for response
  method: string;           // e.g., "codex/requestApproval/fileChange"
  params: Record<string, unknown>;  // Tool-specific params
};
```

### Response Mechanism

```typescript
// Frontend calls:
await respondToServerRequest(workspaceId, requestId, decision);

// Backend sends JSON-RPC response:
{"id": <request_id>, "result": {"decision": "accept"}}
// or
{"id": <request_id>, "result": {"decision": "decline"}}
```

---

## UI State Management

### Reducer State Shape

```typescript
type ThreadState = {
  // Active thread per workspace
  activeThreadIdByWorkspace: Record<string, string | null>;

  // Conversation items per thread
  itemsByThread: Record<string, ConversationItem[]>;

  // Thread summaries per workspace
  threadsByWorkspace: Record<string, ThreadSummary[]>;

  // Thread activity status
  threadStatusById: Record<string, ThreadActivityStatus>;

  // Loading states
  threadListLoadingByWorkspace: Record<string, boolean>;

  // Active turn tracking (for interrupt)
  activeTurnIdByThread: Record<string, string | null>;

  // Pending approvals
  approvals: UnifiedApprovalRequest[];

  // Token usage per thread
  tokenUsageByThread: Record<string, ThreadTokenUsage>;

  // Rate limits per workspace
  rateLimitsByWorkspace: Record<string, RateLimitSnapshot | null>;

  // Turn plans per thread
  planByThread: Record<string, TurnPlan | null>;

  // Last agent message for preview
  lastAgentMessageByThread: Record<string, { text: string; timestamp: number }>;
};
```

### Key Reducer Actions

| Action | Purpose |
|--------|---------|
| `ensureThread` | Create thread entry if not exists |
| `setActiveThreadId` | Switch active thread in workspace |
| `markProcessing` | Track processing state + timing |
| `markReviewing` | Track review mode state |
| `addUserMessage` | Add user message to thread |
| `appendAgentDelta` | Append streaming text chunk |
| `completeAgentMessage` | Finalize agent message |
| `upsertItem` | Insert or update conversation item |
| `addApproval` | Queue approval request |
| `removeApproval` | Clear approval after response |
| `setThreadTokenUsage` | Update token counters |
| `setRateLimits` | Update rate limit display |
| `setThreadPlan` | Update turn plan steps |

### Conversation Item Types

```typescript
type ConversationItem =
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string }
  | { id: string; kind: "reasoning"; summary: string; content: string }
  | { id: string; kind: "diff"; title: string; diff: string; status?: string }
  | { id: string; kind: "review"; state: "started" | "completed"; text: string }
  | { id: string; kind: "tool"; toolType: string; title: string; detail: string;
      status?: string; output?: string; changes?: ToolChange[] };
```

### Streaming Text Merge Algorithm

The `mergeStreamingText` function handles overlapping deltas:

```typescript
function mergeStreamingText(existing: string, delta: string) {
  // Handle identical, prefix cases
  if (delta === existing) return existing;
  if (delta.startsWith(existing)) return delta;
  if (existing.startsWith(delta)) return existing;

  // Find overlap and merge
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (existing.endsWith(delta.slice(0, length))) {
      return `${existing}${delta.slice(length)}`;
    }
  }
  return `${existing}${delta}`;
}
```

---

## File Reference

### Backend (Rust)

| File | Purpose |
|------|---------|
| `src-tauri/src/codex.rs` | Codex process management, IPC commands |
| `src-tauri/src/lib.rs` | Tauri command registration |
| `src-tauri/src/state.rs` | Application state (sessions map) |
| `src-tauri/src/types.rs` | Workspace, settings types |

### Frontend (React/TypeScript)

| File | Purpose |
|------|---------|
| `src/hooks/useAppServerEvents.ts` | Event listener for Codex events |
| `src/hooks/useThreads.ts` | Thread/conversation management |
| `src/hooks/useThreadsReducer.ts` | State reducer for threads |
| `src/services/tauri.ts` | Tauri IPC wrappers |
| `src/utils/threadItems.ts` | Item parsing, normalization |
| `src/types.ts` | TypeScript type definitions |
| `src/App.tsx` | Main app composition |
| `src/components/ApprovalToasts.tsx` | Approval UI |

---

## Feature Parity Checklist

When implementing Claude-native equivalents, ensure these features work:

### Session Management
- [ ] Start new session in workspace
- [ ] Resume existing session
- [ ] List sessions for workspace
- [ ] Archive (hide) session
- [ ] Session persists after app restart

### Messaging
- [ ] Send text message
- [ ] Send images with message
- [ ] Receive streaming text deltas
- [ ] Complete message finalization
- [ ] Handle message errors

### Tool Execution
- [ ] Tool started indicator
- [ ] Tool progress updates
- [ ] Tool completion with output
- [ ] File change display with diff
- [ ] Command execution output

### Approvals
- [ ] Permission request appears as toast
- [ ] Toast shows tool name and details
- [ ] Accept sends allow response
- [ ] Decline sends deny response
- [ ] Toast dismisses after response

### Session Control
- [ ] Interrupt active turn
- [ ] Processing indicator (spinner)
- [ ] Turn timing measurement
- [ ] Unread message indicator

### Metadata
- [ ] Token usage display
- [ ] Rate limit display
- [ ] Turn plan steps display
- [ ] Model selection

### Thread List
- [ ] Threads sorted by activity
- [ ] Thread preview text
- [ ] Thread rename based on first message
- [ ] Thread loading indicator

---

## Strengths and Limitations

### Strengths of Codex Integration

1. **Mature Protocol**: JSON-RPC is well-defined and debuggable
2. **Process Isolation**: Each workspace has independent process
3. **Rich Events**: Granular events for UI updates
4. **Thread Persistence**: Threads persist across sessions
5. **Review Mode**: Built-in code review functionality

### Limitations

1. **Node Dependency**: Requires Node.js installation
2. **Startup Time**: Process spawn adds latency
3. **Memory Usage**: Separate process per workspace
4. **Event Complexity**: Many event types to handle
5. **Limited Customization**: Fixed tool set

### Patterns to Preserve in Claude-Native

1. **Workspace Isolation**: Keep sessions workspace-scoped
2. **Event-Driven Updates**: Continue using Tauri events
3. **Reducer Pattern**: Maintain predictable state updates
4. **Streaming Support**: Handle text deltas efficiently
5. **Approval Flow**: Keep approval UX familiar

### Patterns to Improve

1. **Registry-Based Listing**: Use local registry instead of RPC pagination
2. **Direct SDK Access**: Eliminate process spawn overhead
3. **Unified Event Types**: Simplify event taxonomy
4. **Better Error Recovery**: Add retry logic for transient failures

---

## Migration Notes

### Terminology Mapping

| Codex Term | Claude Term |
|------------|-------------|
| Thread | Session |
| Turn | Query |
| Item | Event/Message |
| request_id | tool_use_id |
| app-server | Claude Bridge |

### Key Behavioral Differences

1. **Session IDs**: Claude uses UUIDs from transcript files
2. **Permissions**: Claude uses `tool_use_id` for responses
3. **Events**: Claude events have different structure
4. **Persistence**: Claude stores transcripts in `~/.claude/projects/`

---

*This document was generated to support the Claude-native migration. Future agents should reference this when implementing features to ensure behavioral parity with the original Codex integration.*
