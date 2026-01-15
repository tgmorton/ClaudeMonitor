# Claude Agent SDK Feature Coverage and Long‑Term Goals

## Purpose
Define the long‑term feature surface CodexMonitor should cover when built on the Claude Agent SDK. This document describes desired capabilities, current coverage, gaps, and planned enhancements.

## Guiding Principles
- Claude‑native end‑to‑end workflow.
- Registry‑based session visibility with Claude as the source of session data.
- Human‑centered approvals and auditability for tool usage.
- Transparent, debuggable agent behavior in UI.

## Core Capabilities and Targets

### 1) Session Lifecycle (Primary)
**Goal:** Full parity with Claude Code sessions while maintaining a curated registry for visibility.

- **Start session**: create new session per workspace.
- **Resume session**: resume by session ID.
- **Archive**: hide from registry only (no deletion).
- **Import**: scan Claude project folders and select sessions.
- **Session metadata**: maintain preview, lastActivity, transcriptPath, projectPath.

**SDK leverage**
- `query()` with `persistSession: true`.
- `resume` option.
- Hook events (`SessionStart`, `SessionEnd`) for transcript path.

**Current coverage**
- Start/resume/interrupt wired through bridge.
- Registry and scan helpers implemented.

**Gaps / long‑term**
- Robust import UI and conflict handling.
- Session metadata enrichment (context window, model info).
- Recovery when transcript missing (mark missing, offer recreate).

---

### 2) Messaging + Streaming
**Goal:** Real‑time streaming UI with accurate completion state, usable for long tasks.

- **Partial deltas**: show streaming responses.
- **Completion**: stable final text for transcripts and thread list.
- **Multi‑turn**: continuous conversation with correct ordering.

**SDK leverage**
- `includePartialMessages: true` yields `SDKPartialAssistantMessage`.
- `SDKAssistantMessage` completion.

**Current coverage**
- Delta handling in `useClaudeEvents`.
- Completion from assistant messages.

**Gaps / long‑term**
- Better chunk coalescing and fallback when stream events omit text.
- Accurate “typing” indicator synced with tool use.

---

### 3) Permissions + Approvals
**Goal:** Transparent, user‑controlled tool execution.

- **Prompt on tool use**: show tool, input, and intent.
- **Approve / deny** with optional “always allow.”
- **Timeout handling**: safe default denial.

**SDK leverage**
- `canUseTool` callback.
- `PermissionRequest` hook.
- Permission updates via `PermissionUpdate`.

**Current coverage**
- Permission requests forwarded; approval toasts exist.

**Gaps / long‑term**
- “Allow always for this tool” UX.
- Permission mode presets per workspace.

---

### 4) Tools + Execution Visibility
**Goal:** Surface tool usage in the conversation timeline.

- **Tool start**: show tool name and inputs.
- **Tool progress**: show running state.
- **Tool output**: show result summary and raw output when relevant.

**SDK leverage**
- `SDKToolProgressMessage`.
- Tool results embedded in assistant messages.

**Current coverage**
- Tool progress event shown; tool outputs partially surfaced.

**Gaps / long‑term**
- Extract tool outputs from assistant messages where possible.
- Map to diff view for file changes.

---

### 5) Model + Capability Selection
**Goal:** Make model selection explicit, safe, and discoverable.

- **Model list** from SDK.
- **Per‑workspace or per‑session model** selection.
- **Fallback model** (optional).

**SDK leverage**
- `supportedModels()`.
- `setModel()` on Query.

**Current coverage**
- Model listing stubbed.

**Gaps / long‑term**
- UI model picker tied to session state.
- Automatic fallback policies.

---

### 6) Skills + Commands
**Goal:** Surface Claude skills and custom prompts.

- **List skills/commands**.
- **Show argument hints**.
- **Support /commands in composer.**

**SDK leverage**
- `supportedCommands()` and `SDKSystemMessage` skills list.

**Current coverage**
- Partial skills list in UI for Codex; Claude not yet wired.

**Gaps / long‑term**
- Skills pane for Claude.
- Autocomplete for slash commands.

---

### 7) Usage + Cost Visibility
**Goal:** Track usage, cost, and limits in context.

- **Session usage** summary after completion.
- **Cost** and token breakdown.
- **Rate limits** if available.

**SDK leverage**
- `SDKResultMessage` includes `usage` and `total_cost_usd`.

**Current coverage**
- Result usage is captured; UI partially wired.

**Gaps / long‑term**
- UI budget warnings.
- Aggregated usage per workspace.

---

### 8) File Checkpointing / Rewind (Future)
**Goal:** Allow safe rollback of agent changes.

**SDK leverage**
- `enableFileCheckpointing` and `rewindFiles()`.

**Current coverage**
- Not implemented.

**Long‑term**
- Add “Rewind to message” UI.
- Integrate with diff viewer.

---

### 9) Plugins + MCP Servers (Future)
**Goal:** Allow custom MCP servers and plugins for extended tooling.

**SDK leverage**
- `mcpServers` option; `setMcpServers()` at runtime.
- `createSdkMcpServer()` for local tools.

**Current coverage**
- Not implemented.

**Long‑term**
- MCP server manager in Settings.
- Per‑workspace tool sets.

---

### 10) Multi‑Agent / Sub‑Agents (Future)
**Goal:** Delegate tasks to specialized sub‑agents.

**SDK leverage**
- `agents` option in `query()`.

**Current coverage**
- Not implemented.

**Long‑term**
- UI for sub‑agent selection.
- Workflow templates for agents.

---

## Phased Roadmap

### Phase 1 — Claude‑Native Baseline (Now)
- Claude session lifecycle + registry list.
- Approvals and streaming output.
- Settings for Claude Code path + permission mode.

### Phase 2 — Workflow UX
- Session import UI in workspace menu.
- Model picker and skills list.
- Better tool output capture.

### Phase 3 — Safety + Rollback
- File checkpointing and rewind.
- Diff integration post‑turn.

### Phase 4 — Extensibility
- MCP servers and plugins.
- Sub‑agents and task orchestration.

## Non‑Goals (for now)
- Automatic deletion of Claude sessions.
- Hidden or mixed provider handling (Codex is legacy only).

## Acceptance Criteria (Long‑Term)
- Claude Agent SDK is the single runtime.
- Session list is accurate, curated, and resilient.
- Approvals, tool visibility, and cost transparency are first‑class.
- Advanced capabilities (MCP, rewind, sub‑agents) are staged, not bolted on.

