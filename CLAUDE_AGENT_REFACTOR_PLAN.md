# Claude Agent SDK Refactor Master Plan

## Goal
Replace the current Codex app-server integration with Claude Agent SDK while preserving as much feature parity as possible. Thread lifecycle must be reliable and user-controllable, using Claude's persisted sessions as the data source and an app-managed registry as the visibility source.

## Scope
- Backend: replace Codex process + JSON-RPC with Claude Agent SDK bridge.
- Frontend: refactor event parsing and thread state to match Claude SDK events.
- Persistence: introduce a thread/session registry that selects which Claude sessions appear in the UI.
- Parity: match existing Codex feature set where possible; document gaps and mitigations.

## Non-goals
- Do not delete Claude sessions on archive (archive only removes from registry).
- Do not rely on Codex app-server protocol or JSON-RPC.

## Architecture Summary
- **Claude Bridge (Node)**: a long-running child process per workspace that uses `@anthropic-ai/claude-agent-sdk` and streams JSON events to stdout. It accepts control commands via stdin.
- **Tauri Backend (Rust)**: spawns the bridge, forwards events to the UI, and maintains the registry of visible sessions.
- **Frontend (React)**: consumes Claude events and registry-backed thread lists, handles approvals, and renders streaming content.

## Thread Lifecycle Model (Authoritative)
- **Data source**: Claude sessions persisted on disk in `~/.claude/projects/...` (SDK `persistSession: true`).
- **Visibility source**: app-managed registry of sessions per workspace.
- **Archive**: remove from registry only; no deletion from disk.
- **Import**: list sessions from the Claude project folder and allow users to select which appear in the UI.
- **Create**: new session created via SDK, then inserted into registry once `sessionId` is known.
- **Resume**: use stored `sessionId` via SDK `resume` option.
- **Failure handling**: if resume fails, mark session as missing and allow user to recreate or re-import.

## Registry Schema (Proposed)
Stored per workspace in `threads.json` (or merged into existing settings).

```json
{
  "version": 1,
  "workspaces": {
    "<workspaceId>": {
      "projectPath": "/Users/.../.claude/projects/<project>",
      "visibleSessionIds": ["<sessionId>", "<sessionId>"]
    }
  },
  "sessions": {
    "<sessionId>": {
      "sessionId": "<sessionId>",
      "cwd": "/path/to/workspace",
      "preview": "short summary",
      "createdAt": 1710000000000,
      "lastActivity": 1710000000000,
      "transcriptPath": "/Users/.../.claude/projects/.../transcript.json",
      "projectPath": "/Users/.../.claude/projects/...",
      "status": "active" | "missing"
    }
  }
}
```

## SDK Integration Notes (Confirmed from sdk.d.ts)
- Sessions persist by default (`persistSession: true`) to `~/.claude/projects/`.
- Resume supported via `resume` option.
- Permission requests via `canUseTool` and `PermissionRequest` hooks.
- Streaming deltas via `SDKPartialAssistantMessage`.
- Result usage via `SDKResultMessage`.
- Model list via `supportedModels()`; skills via `supportedCommands()`.

## Feature Parity Matrix

### Threads
- Start: YES (SDK session start)
- Resume: YES (`resume`)
- List: NO native; use registry + Claude project scan
- Archive: NO native; remove from registry only

### Turns / Messages
- Start: YES (send user message)
- Interrupt: YES (`query.interrupt()`)
- Completed: YES (`SDKResultMessage`)
- Plan updates: NO (omit or show "not supported")

### Streaming / Items
- Agent message delta: YES (`SDKPartialAssistantMessage`)
- Agent message complete: YES (`SDKAssistantMessage`)
- Tool output streaming: PARTIAL (depends on tool output visibility)
- Diff updates: NO (compute after completion if needed)

### Approvals
- Request approval: YES (`canUseTool`, `PermissionRequest` hook)
- Respond: YES (bridge returns allow/deny)

### Models / Skills
- Model list: YES (`supportedModels()`)
- Skills list: YES (`supportedCommands()`)
- Prompts list: NO (use CLAUDE.md discovery instead)

### Usage / Rate Limits
- Token usage: PARTIAL (final usage only)
- Rate limits: NO (show account info only)

### Images
- Supported via MessageParam (user message content)

## Workstreams and Responsibilities

### Agent A: Bridge + Tauri IPC
- Build Node bridge around `query()` or `unstable_v2_createSession`.
- Define stdin control messages and stdout event schema.
- Implement Rust process supervision, event forwarding, and IPC commands.

### Agent B: Frontend Protocol + UI
- Replace event parsing in `src/hooks/useAppServerEvents.ts`.
- Refactor thread state machine in `src/hooks/useThreads.ts`.
- Update UI for settings and missing parity features.

### Agent C: Registry + Persistence
- Implement `threads.json` read/write and migration.
- Build project session scanning utilities.
- Tie registry updates to session lifecycle events.

### Agent D: QA + Docs
- Create manual test plan for lifecycle and approvals.
- Document new session import flow and settings.

## Detailed Execution Plan

### Phase 0: Discovery + Event Spec
- Define Claude bridge event schema:
  - `session/started`, `session/updated`, `message/delta`, `message/complete`, `permission/request`, `result`, `error`.
- Specify which fields are mandatory (`sessionId`, `workspaceId`, `threadId`).

### Phase 1: Claude Bridge (Node)
- Create `src/claude-bridge/index.ts`:
  - Accept JSON control messages over stdin.
  - Manage active sessions map.
  - Emit JSON events over stdout.
- Implement:
  - `startSession(cwd, model, permissionMode, tools)`
  - `sendMessage(sessionId, text, images)`
  - `interrupt(sessionId)`
  - `resumeSession(sessionId)`
  - `listProjectSessions(projectPath)` (scan disk)
- Implement hooks for:
  - Session start (capture transcript path + session ID)
  - Permission requests (forward to UI)
  - Streaming deltas
  - Result summary and usage

### Phase 2: Tauri Backend (Rust)
- New module: `src-tauri/src/claude.rs`.
- Replace commands in `src-tauri/src/lib.rs`:
  - `start_thread`, `send_user_message`, `turn_interrupt`, `list_threads`, `resume_thread`, `archive_thread`.
- Connect bridge stdout to UI event emitter.
- Implement registry APIs:
  - `get_project_sessions(workspaceId)`
  - `set_visible_sessions(workspaceId, sessionIds)`
  - `archive_thread(workspaceId, threadId)`
  - `create_thread(workspaceId)`
- Ensure registry writes are atomic and crash-safe.

### Phase 3: Frontend Refactor
- Replace Codex JSON-RPC handling with Claude event handling.
- Update thread list UI:
  - Import sessions from project
  - Show hidden sessions
  - Archive removes from list
- Update settings UI:
  - Replace Codex binary with Claude Code executable path
  - Update doctor flow

### Phase 4: Lifecycle Robustness
- Resume failures:
  - Mark session as missing
  - Provide "Recreate session" flow
- Preview + activity updates:
  - Update on user send + assistant complete
- Add telemetry to debug panel for new events

### Phase 5: Parity Gaps + Mitigations
- Plan updates: hide panel or show "unsupported" badge.
- Diff updates: compute diffs after completion if required.
- Rate limits: show account info and usage only.

### Phase 6: QA + Docs
- Manual test plan:
  - Add workspace, import sessions, resume
  - Create new session
  - Approval prompts
  - Interrupt + retry
  - Archive + restore
- Update README and settings documentation.

## Open Questions
- Confirm Claude project path mapping for a given `cwd`.
- Determine how to list sessions for a project (file layout under `~/.claude/projects`).
- Confirm which SDK event types provide tool output details.

## Next Steps
1. Confirm project session discovery strategy (scan disk vs SDK hooks only).
2. Define event schema for bridge <-> Tauri.
3. Start implementing Node bridge and registry APIs.
