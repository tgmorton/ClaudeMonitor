# Claude Remaining Phases — Agent Assignments

This document assigns Phase 2–4 work (post‑plan) to Agents A–D.

## Phase 2 — Workflow UX

### Agent A (Backend + Bridge)
- Expose `supportedModels()` and `supportedCommands()` through new Tauri commands.
- Add command to list available MCP servers (if needed for future UI).
- Ensure bridge emits any relevant SDK system/init metadata.
- Files:
  - `src/claude-bridge/session-manager.ts`
  - `src/claude-bridge/types.ts`
  - `src-tauri/src/claude.rs`
  - `src-tauri/src/lib.rs`

### Agent B (Frontend + UI)
- Model picker UI (per workspace or per session) and wire to Claude start/session.
- Skills list and /command autocomplete in composer.
- Improve tool cards for live sessions (tool started/progress/completed events).
- Files:
  - `src/components/ComposerMetaBar.tsx`
  - `src/components/ComposerInput.tsx`
  - `src/hooks/useThreads.ts`
  - `src/hooks/useSkills.ts`
  - `src/components/Messages.tsx`

### Agent C (Registry + Session UX)
- Import sessions UI polish (workspace menu). 
- Optional “show hidden sessions” filter.
- Files:
  - `src/components/Sidebar.tsx`
  - `src/components/ImportSessionsModal.tsx`
  - `src/hooks/useRegistry.ts`

### Agent D (Legacy cleanup + docs)
- Update `docs/legacy-codex.md` with any remaining Codex notes.
- Confirm Codex UI elements stay hidden.
- Files:
  - `docs/legacy-codex.md`
  - `src/components/SettingsView.tsx`

---

## Phase 3 — Safety + Rollback

### Agent A (Backend + Bridge)
- Enable `enableFileCheckpointing` in Claude bridge options.
- Add `rewindFiles()` Tauri command and bridge control.
- Files:
  - `src/claude-bridge/session-manager.ts`
  - `src-tauri/src/claude.rs`
  - `src-tauri/src/lib.rs`

### Agent B (Frontend + UI)
- Add “Rewind to message” UI control.
- Display diff summary after rewind or after completion.
- Files:
  - `src/components/Messages.tsx`
  - `src/hooks/useThreads.ts`
  - `src/components/GitDiffPanel.tsx`

### Agent C (Registry + Session UX)
- Mark session “missing” if transcript or checkpoints are gone.
- Files:
  - `src-tauri/src/registry.rs`
  - `src/hooks/useRegistry.ts`

### Agent D (Legacy cleanup + docs)
- Update safety documentation and user guidance.
- Files:
  - `docs/claude-agent-sdk-features.md`

---

## Phase 4 — Extensibility

### Agent A (Backend + Bridge)
- Add MCP server support (`mcpServers`, `setMcpServers`).
- Add plugin loading support.
- Add sub‑agent configuration pass‑through.
- Files:
  - `src/claude-bridge/session-manager.ts`
  - `src/claude-bridge/types.ts`
  - `src-tauri/src/claude.rs`
  - `src-tauri/src/lib.rs`

### Agent B (Frontend + UI)
- Settings UI for MCP servers and plugins.
- Sub‑agent picker in composer (or workflow menu).
- Files:
  - `src/components/SettingsView.tsx`
  - `src/components/ComposerMetaBar.tsx`
  - `src/hooks/useThreads.ts`

### Agent C (Registry + Session UX)
- Persist MCP/plugin configuration per workspace.
- Files:
  - `src-tauri/src/settings.rs`
  - `src-tauri/src/types.rs`
  - `src/hooks/useAppSettings.ts`

### Agent D (Legacy cleanup + docs)
- Final “Claude native” documentation pass.
- Files:
  - `docs/claude-agent-sdk-features.md`
  - `CLAUDE_NATIVE_MASTER_PLAN.md`

---

## Cross‑Phase Dependencies
- Phase 2 model/skills work depends on stable Claude session start/resume.
- Phase 3 rewind depends on enabling file checkpointing in the bridge.
- Phase 4 depends on stable MCP server support in the bridge and settings.

