# Claude Native Master Plan (Path A)

## Goal
Deliver a Claude‑native CodexMonitor with registry‑backed sessions and Claude event wiring as the primary runtime. Codex infrastructure is removed from runtime paths and documented for reference.

## High‑Level Decisions
- **Claude‑native only**: All UI actions and thread lifecycle use Claude Agent SDK.
- **Thread list = registry only**: UI shows only sessions registered in `threads.json`.
- **Session import**: Exposed via workspace menu (preferred), not automatic.
- **Codex legacy**: Removed from active paths; documented in an internal doc for inspiration.

## Scope
- Frontend: Claude event handlers and session lifecycle in main flows.
- Backend: Claude bridge + Tauri IPC, registry integration.
- Persistence: Registry is authoritative for visible sessions.
- Codex: Decommissioned in runtime; captured in docs.

## Agents and Workstreams

### Agent A — Backend + Bridge Integration
**Focus:** Claude bridge runtime, Tauri commands, registry integration.

**A1. Bridge protocol stability**
- Validate command schema: `initialize`, `session/start`, `session/resume`, `message/send`, `message/interrupt`, `permission/respond`, `model/list`.
- Ensure `claudeCodeBin` is passed through and used via SDK `pathToClaudeCodeExecutable`.
- Emit `session/started` with `transcriptPath` and `projectPath` when available.
- Files:
  - `src/claude-bridge/types.ts`
  - `src/claude-bridge/session-manager.ts`
  - `src/claude-bridge/index.ts`

**A2. Tauri IPC (Claude‑only)**
- Ensure commands in `src-tauri/src/lib.rs` are Claude‑only in active flow.
- `claude_doctor` accepts `claude_code_bin`; default from settings.
- `claude_start_session` uses `defaultPermissionMode` and passes `claudeCodeBin`.
- `claude_resume_session` derives `cwd` from workspace path and passes `claudeCodeBin`.
- Files:
  - `src-tauri/src/claude.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/types.rs`
  - `src-tauri/src/settings.rs`

**A3. Registry integration**
- On `session/started`, register the session and mark visible.
- On `result`, update `lastActivity` and preview (if available).
- Ensure atomic writes.
- Files:
  - `src-tauri/src/claude.rs`
  - `src-tauri/src/registry.rs`
  - `src-tauri/src/state.rs`

**A4. Operational QA**
- Smoke test: start, resume, interrupt, permission requests, archive.
- CLI path verification with `claude_doctor`.

---

### Agent B — Frontend UI + Event Wiring
**Focus:** Claude becomes primary UI path.

**B1. Composition root rewiring**
- In `src/App.tsx`, replace Codex handlers with Claude equivalents.
- Ensure message composer, interrupt, and thread list call Claude functions.

**B2. Claude events drive thread state**
- Make `useClaudeEvents` the primary event stream for thread items.
- Map streaming deltas, completion, tool progress, and results into UI state.
- Files:
  - `src/hooks/useClaudeEvents.ts`
  - `src/hooks/useThreads.ts`

**B3. Approval + tool output**
- Ensure approvals use `tool_use_id` and `session_id`.
- Tool output entries should display even without Codex formats.
- Files:
  - `src/hooks/useThreadsReducer.ts`
  - `src/components/ApprovalToasts.tsx`

**B4. Settings UI**
- Claude Code settings are primary.
- Codex settings hidden or moved to “Legacy” section (not used).
- Files:
  - `src/components/SettingsView.tsx`
  - `src/hooks/useAppSettings.ts`

---

### Agent C — Registry + Session Import UX
**Focus:** Registry = thread list, workspace‑menu import.

**C1. Registry correctness**
- Validate scan of `~/.claude/projects/<project>` layout.
- Ensure JSONL parsing is correct and `sessionId` matches filename UUID.
- Files:
  - `src-tauri/src/registry.rs`
  - `src-tauri/src/types.rs`

**C2. Registry‑backed thread list**
- Thread list uses `get_visible_sessions` only.
- Refresh list when workspace connects.
- Files:
  - `src/hooks/useThreads.ts`
  - `src/services/tauri.ts`

**C3. Session import UI (workspace menu)**
- Add workspace menu action: “Import Claude Sessions…”.
- Use `scan_available_sessions` then `import_sessions`.
- Files:
  - `src/components/Sidebar.tsx` or workspace menu component
  - `src/hooks/useRegistry.ts`
  - `src/services/tauri.ts`

---

### Agent D — Codex Decommission + Documentation
**Focus:** Remove active Codex paths, document legacy architecture.

**D1. Identify runtime Codex dependencies**
- Trace Codex usage in:
  - `src/hooks/useAppServerEvents.ts`
  - `src/hooks/useThreads.ts`
  - `src/services/tauri.ts`
  - `src-tauri/src/codex.rs`
  - `src-tauri/src/lib.rs`

**D2. Remove Codex from active execution paths**
- Remove Codex command invocations from `src/App.tsx` and hooks.
- Keep Codex code in repo but no longer referenced in runtime.
- If removal breaks build, isolate behind “legacy” feature flag or dead code.

**D3. Legacy documentation**
- Create `docs/legacy-codex.md`:
  - Summary of Codex app‑server protocol
  - Thread lifecycle handling
  - Approval request flow
  - UI event mapping and state management
  - Notes on strengths/limitations for inspiration

**D4. Final cleanup**
- Ensure unused Codex UI labels are hidden.
- Ensure no Codex IPC commands are called by default.

---

## Cross‑Agent Integration Steps
1. **Registry and Claude session start** must be live before UI wiring.
2. **Claude events** must be stable before UI consumption.
3. **Codex removal** happens after Claude UI is confirmed stable.

## Test Plan (Claude Native)
- Start session in workspace.
- Receive streamed output and completion.
- Resume from registry list.
- Permission request appears and can be approved/denied.
- Archive hides session from list (data remains).
- Claude doctor validates CLI path.

## Risks
- Claude JSONL layout changes may break session scan.
- Tool output streaming may be partial and need UI fallback.
- Missing preview text may affect thread naming in list.

## Acceptance Criteria
- All user actions go through Claude only.
- Thread list shows registry sessions only.
- Approvals, interrupt, resume, and archive work.
- Codex is fully removed from active runtime paths.
- Legacy Codex documented in `docs/legacy-codex.md`.

---

# Post‑Plan: Phase 2–4 Integration Roadmap

This post‑plan kicks in after the Claude‑native baseline is complete and stable. It maps directly to the long‑term feature coverage goals.

## Phase 2 — Workflow UX (Week 1–2)

**Objective:** make Claude workflows feel first‑class: discoverable sessions, models, skills, and command‑driven flows.

### 2.1 Session Import + Discovery
- Add workspace menu action: “Import Claude Sessions…”.
- Scan `~/.claude/projects/<project>` and present sessions with previews.
- Allow multi‑select import and “show hidden sessions” toggle.
- Persist selections via registry.
- Files:
  - `src/components/Sidebar.tsx` (or workspace menu component)
  - `src/hooks/useRegistry.ts`
  - `src/services/tauri.ts`

### 2.2 Model Picker + Defaults
- Add model selector in Composer meta bar or Settings.
- Store per‑workspace model preference (override global).
- Wire to `claudeStartSession` and `Query.setModel()` for active sessions.
- Files:
  - `src/components/ComposerMetaBar.tsx`
  - `src/hooks/useThreads.ts`
  - `src/types.ts`

### 2.3 Skills + Slash Commands
- Query `supportedCommands()` and display in Settings or sidebar.
- Add command autocomplete in composer (reuse existing prompt autocomplete UX).
- Files:
  - `src/hooks/useSkills.ts` (extend for Claude)
  - `src/components/ComposerInput.tsx`
  - `src/utils/customPrompts.ts`

### 2.4 Tool Output UX
- Improve tool cards in the thread timeline.
- Extract tool results from assistant messages where available.
- Files:
  - `src/hooks/useThreads.ts`
  - `src/utils/threadItems.ts`
  - `src/components/Messages.tsx`

**Exit criteria**
- Import sessions via UI.
- Model selection works and persists.
- Skills list and /command autocomplete functional.
- Tool usage visible and legible in thread timeline.

---

## Phase 3 — Safety + Rollback (Week 2–3)

**Objective:** safe experimentation with agent changes and clear audit trails.

### 3.1 File Checkpointing
- Enable `enableFileCheckpointing` in Claude bridge options.
- Implement `rewindFiles()` in Tauri command and UI action.
- Files:
  - `src/claude-bridge/session-manager.ts`
  - `src-tauri/src/claude.rs`
  - `src/hooks/useThreads.ts`

### 3.2 Diff Integration
- After completion, compute diffs for modified files in session.
- Surface diffs in existing Git diff panel or inline cards.
- Files:
  - `src/hooks/useGitDiffs.ts`
  - `src/components/GitDiffPanel.tsx`

**Exit criteria**
- Rewind to previous message is possible and visible.
- Diffs appear after a session run.

---

## Phase 4 — Extensibility (Week 3–4)

**Objective:** unlock power‑user and team workflows: MCP, plugins, sub‑agents.

### 4.1 MCP Server Manager
- Add Settings section for MCP server configs.
- Pass `mcpServers` to Claude bridge.
- Allow runtime changes via `setMcpServers()`.
- Files:
  - `src/components/SettingsView.tsx`
  - `src/claude-bridge/session-manager.ts`
  - `src-tauri/src/claude.rs`

### 4.2 Plugins
- Add local plugin loader UI.
- Load plugin paths into Claude options.
- Files:
  - `src/components/SettingsView.tsx`
  - `src/claude-bridge/session-manager.ts`

### 4.3 Sub‑Agents / Task Routing
- Define optional agent presets in settings or a config file.
- Expose a “Task” UI entry to select sub‑agent.
- Pass `agents` into `query()`.
- Files:
  - `src/claude-bridge/session-manager.ts`
  - `src/components/ComposerMetaBar.tsx`
  - `src/hooks/useThreads.ts`

**Exit criteria**
- MCP servers can be configured and activated.
- Plugins load successfully.
- Sub‑agents are selectable and working in flow.

---

## Future‑Proofing Checklist (Always‑On)
- Keep bridge event payloads forward‑compatible (include raw SDK payloads).
- Registry schema includes optional fields for new SDK metadata.
- Use graceful fallbacks when SDK adds new event types.

