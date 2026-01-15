// MCP Server configuration for workspace-level settings
export type WorkspaceMcpServerConfig = {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

// Plugin configuration for workspace-level settings
export type WorkspacePluginConfig = {
  type: "local";
  path: string;
};

export type WorkspaceSettings = {
  sidebarCollapsed: boolean;
  sortOrder?: number | null;
  mcpServers?: Record<string, WorkspaceMcpServerConfig>;
  plugins?: WorkspacePluginConfig[];
};

export type WorkspaceKind = "main" | "worktree";

export type WorktreeInfo = {
  branch: string;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  codex_bin?: string | null;
  kind?: WorkspaceKind;
  parentId?: string | null;
  worktree?: WorktreeInfo | null;
  settings: WorkspaceSettings;
};

export type AppServerEvent = {
  workspace_id: string;
  message: Record<string, unknown>;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ConversationItem =
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string }
  | { id: string; kind: "reasoning"; summary: string; content: string }
  | { id: string; kind: "diff"; title: string; diff: string; status?: string }
  | { id: string; kind: "review"; state: "started" | "completed"; text: string }
  | {
      id: string;
      kind: "tool";
      toolType: string;
      title: string;
      detail: string;
      status?: string;
      output?: string;
      elapsedSeconds?: number;
      changes?: { path: string; kind?: string; diff?: string }[];
    };

export type ThreadSummary = {
  id: string;
  name: string;
  status?: "active" | "missing";
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type AccessMode = "read-only" | "current" | "full-access";

// Permission mode for Claude sessions
export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk";

// Rewind result from file checkpointing
export type RewindDiffResult = {
  filesChanged: number;
  additions: number;
  deletions: number;
  files?: { path: string; status: string; additions: number; deletions: number }[];
};

// MCP Server configuration
export type MCPServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  command?: string;
  args?: string[];
};

export type AppSettings = {
  codexBin: string | null;
  claudeCodeBin: string | null;
  defaultAccessMode: AccessMode;
  defaultPermissionMode: PermissionMode;
  uiScale: number;
  mcpServers?: MCPServerConfig[];
};

export type CodexDoctorResult = {
  ok: boolean;
  codexBin: string | null;
  version: string | null;
  appServerOk: boolean;
  details: string | null;
  path: string | null;
  nodeOk: boolean;
  nodeVersion: string | null;
  nodeDetails: string | null;
};

export type ApprovalRequest = {
  workspace_id: string;
  request_id: number;
  method: string;
  params: Record<string, unknown>;
};

export type GitFileStatus = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type GitFileDiff = {
  path: string;
  diff: string;
};

export type DiffLineReference = {
  path: string;
  type: "add" | "del" | "context" | "mixed";
  oldLine: number | null;
  newLine: number | null;
  endOldLine: number | null;
  endNewLine: number | null;
  lines: string[];
};

export type GitLogEntry = {
  sha: string;
  summary: string;
  author: string;
  timestamp: number;
};

export type GitLogResponse = {
  total: number;
  entries: GitLogEntry[];
  ahead: number;
  behind: number;
  aheadEntries: GitLogEntry[];
  behindEntries: GitLogEntry[];
  upstream: string | null;
};

export type GitHubIssue = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
};

export type GitHubIssuesResponse = {
  total: number;
  issues: GitHubIssue[];
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

export type TurnPlanStep = {
  step: string;
  status: TurnPlanStepStatus;
};

export type TurnPlan = {
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: string | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  images?: string[];
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export type SkillOption = {
  name: string;
  path: string;
  description?: string;
};

export type CustomPromptOption = {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
  content: string;
};

export type BranchInfo = {
  name: string;
  lastCommit: number;
};

export type DebugEntry = {
  id: string;
  timestamp: number;
  source: "client" | "server" | "event" | "stderr" | "error";
  label: string;
  payload?: unknown;
};

// ============================================================================
// Claude Bridge Event Types (matching src/claude-bridge/types.ts)
// ============================================================================

// Base event structure from bridge stdout
export type ClaudeBridgeEventBase<T extends string, P> = {
  type: T;
  sessionId: string;
  workspaceId: string;
  timestamp: number;
  payload: P;
};

// Tauri event payload (from Rust ClaudeEvent struct)
export type ClaudeTauriEvent = ClaudeBridgeEvent;

// Event payload types
export type SessionStartedPayload = {
  model: string;
  tools: string[];
  cwd: string;
  claudeCodeVersion: string;
  permissionMode: string;
  mcpServers: { name: string; status: string }[];
  transcriptPath?: string;
  projectPath?: string;
};

export type SessionClosedPayload = {
  reason: "user" | "error" | "completed";
};

export type MessageDeltaPayload = {
  event: unknown; // BetaRawMessageStreamEvent from SDK
  parentToolUseId: string | null;
  uuid?: string;
};

export type MessageCompletePayload = {
  uuid: string;
  message: unknown; // BetaMessage from SDK
  parentToolUseId: string | null;
  error?: string;
};

export type ToolStartedPayload = {
  toolName: string;
  toolUseId: string;
  input: unknown;
  parentToolUseId: string | null;
};

export type ToolProgressPayload = {
  toolName: string;
  toolUseId: string;
  elapsedSeconds: number;
  parentToolUseId: string | null;
};

export type ToolCompletedPayload = {
  toolName: string;
  toolUseId: string;
  output: unknown;
};

export type PermissionRequestPayload = {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  agentId?: string;
};

export type ResultPayload = {
  success: boolean;
  subtype: string;
  result?: string;
  durationMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  errors?: string[];
};

export type ErrorPayload = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type BridgeStderrPayload = {
  message: string;
};

export type BridgeConnectedPayload = unknown;

// Typed event definitions
export type ClaudeSessionStartedEvent = ClaudeBridgeEventBase<"session/started", SessionStartedPayload>;
export type ClaudeSessionClosedEvent = ClaudeBridgeEventBase<"session/closed", SessionClosedPayload>;
export type ClaudeMessageDeltaEvent = ClaudeBridgeEventBase<"message/delta", MessageDeltaPayload>;
export type ClaudeMessageCompleteEvent = ClaudeBridgeEventBase<"message/complete", MessageCompletePayload>;
export type ClaudeToolStartedEvent = ClaudeBridgeEventBase<"tool/started", ToolStartedPayload>;
export type ClaudeToolProgressEvent = ClaudeBridgeEventBase<"tool/progress", ToolProgressPayload>;
export type ClaudeToolCompletedEvent = ClaudeBridgeEventBase<"tool/completed", ToolCompletedPayload>;
export type ClaudePermissionRequestEvent = ClaudeBridgeEventBase<"permission/request", PermissionRequestPayload>;
export type ClaudeResultEvent = ClaudeBridgeEventBase<"result", ResultPayload>;
export type ClaudeErrorEvent = ClaudeBridgeEventBase<"error", ErrorPayload>;
export type ClaudeBridgeStderrEvent = ClaudeBridgeEventBase<"bridge/stderr", BridgeStderrPayload>;
export type ClaudeBridgeConnectedEvent = ClaudeBridgeEventBase<"bridge/connected", BridgeConnectedPayload>;

// Union of all bridge events
export type ClaudeBridgeEvent =
  | ClaudeSessionStartedEvent
  | ClaudeSessionClosedEvent
  | ClaudeMessageDeltaEvent
  | ClaudeMessageCompleteEvent
  | ClaudeToolStartedEvent
  | ClaudeToolProgressEvent
  | ClaudeToolCompletedEvent
  | ClaudePermissionRequestEvent
  | ClaudeResultEvent
  | ClaudeErrorEvent
  | ClaudeBridgeStderrEvent
  | ClaudeBridgeConnectedEvent;

// Claude approval request (used in UI state, derived from PermissionRequestEvent)
export type ClaudeApprovalRequest = {
  workspace_id: string;
  session_id: string;
  tool_use_id: string; // Primary identifier for responding
  tool_name: string;
  tool_input: Record<string, unknown>;
  suggestions?: unknown[];
  blocked_path?: string;
  decision_reason?: string;
};

// Registry-based session info
export type SessionInfo = {
  sessionId: string;
  cwd: string;
  preview: string;
  createdAt: number;
  lastActivity: number;
  transcriptPath: string;
  projectPath: string;
  status: "active" | "missing";
};

// Claude Code doctor result (from claude_doctor Tauri command)
export type ClaudeDoctorResult = {
  ok: boolean;
  nodeOk: boolean;
  nodeVersion: string | null;
  nodeDetails: string | null;
  claudeOk: boolean;
  claudeVersion: string | null;
  claudeDetails: string | null;
  path: string | null;
};

// Registry types for session persistence (matches Rust backend)
export type SessionStatus = "active" | "missing";

export type SessionEntry = {
  sessionId: string;
  cwd: string;
  preview: string | null;
  createdAt: number;
  lastActivity: number;
  transcriptPath: string | null;
  projectPath: string | null;
  status: SessionStatus;
};
