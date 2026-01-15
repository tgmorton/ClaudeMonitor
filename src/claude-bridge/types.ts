import type {
  SDKMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKToolProgressMessage,
  PermissionResult,
  PermissionUpdate,
  PermissionMode,
  ModelInfo,
  SlashCommand,
  McpServerStatus,
  Query,
} from "@anthropic-ai/claude-agent-sdk";

// Re-export SDK types we need
export type {
  SDKMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKToolProgressMessage,
  PermissionResult,
  PermissionUpdate,
  PermissionMode,
  ModelInfo,
  SlashCommand,
  McpServerStatus,
  Query,
};

// ============================================================================
// Stdin Commands (Tauri -> Bridge)
// ============================================================================

export type CommandMethod =
  | "initialize"
  | "session/start"
  | "session/resume"
  | "session/close"
  | "session/rewind"
  | "message/send"
  | "message/interrupt"
  | "permission/respond"
  | "model/list"
  | "model/set"
  | "command/list"
  | "mcp/status"
  | "mcp/set";

export type BridgeCommand<
  M extends CommandMethod = CommandMethod,
  P = unknown,
> = {
  id: number;
  method: M;
  params: P;
};

// Command parameter types
export type InitializeParams = {
  clientInfo: {
    name: string;
    version: string;
  };
};

// MCP server configuration types (Phase 4)
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

// Plugin configuration types (Phase 4)
export type PluginConfig = {
  type: "local";
  path: string;
};

// Sub-agent definition types (Phase 4)
export type AgentDefinition = {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  mcpServers?: (string | Record<string, McpServerConfig>)[];
};

export type SessionStartParams = {
  workspaceId: string;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  claudeCodeBin?: string;
  // Phase 3: File checkpointing
  enableFileCheckpointing?: boolean;
  // Phase 4: Extensibility options
  mcpServers?: Record<string, McpServerConfig>;
  plugins?: PluginConfig[];
  agents?: Record<string, AgentDefinition>;
};

export type SessionResumeParams = {
  workspaceId: string;
  sessionId: string;
  cwd: string;
  claudeCodeBin?: string;
};

export type SessionCloseParams = {
  sessionId: string;
};

export type MessageSendParams = {
  sessionId: string;
  workspaceId: string;
  message: string;
  images?: string[];
  messageId?: string;
};

export type MessageInterruptParams = {
  sessionId: string;
};

export type PermissionRespondParams = {
  sessionId: string;
  toolUseId: string;
  decision: "allow" | "deny";
  message?: string;
  updatedPermissions?: PermissionUpdate[];
};

export type ModelSetParams = {
  sessionId: string;
  model: string;
};

export type CommandListParams = {
  sessionId?: string;
};

export type McpStatusParams = {
  sessionId: string;
};

export type ModelListParams = {
  sessionId?: string;
};

// Phase 3: Rewind files params
export type RewindFilesParams = {
  sessionId: string;
  userMessageId: string;
  dryRun?: boolean;
};

export type RewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
};

// Phase 4: Set MCP servers params
export type SetMcpServersParams = {
  sessionId: string;
  servers: Record<string, McpServerConfig>;
};

export type SetMcpServersResult = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
};

// Type-safe command definitions
export type InitializeCommand = BridgeCommand<"initialize", InitializeParams>;
export type SessionStartCommand = BridgeCommand<
  "session/start",
  SessionStartParams
>;
export type SessionResumeCommand = BridgeCommand<
  "session/resume",
  SessionResumeParams
>;
export type SessionCloseCommand = BridgeCommand<
  "session/close",
  SessionCloseParams
>;
export type MessageSendCommand = BridgeCommand<
  "message/send",
  MessageSendParams
>;
export type MessageInterruptCommand = BridgeCommand<
  "message/interrupt",
  MessageInterruptParams
>;
export type PermissionRespondCommand = BridgeCommand<
  "permission/respond",
  PermissionRespondParams
>;
export type ModelListCommand = BridgeCommand<"model/list", ModelListParams>;
export type ModelSetCommand = BridgeCommand<"model/set", ModelSetParams>;
export type CommandListCommand = BridgeCommand<"command/list", CommandListParams>;
export type McpStatusCommand = BridgeCommand<"mcp/status", McpStatusParams>;
export type RewindFilesCommand = BridgeCommand<"session/rewind", RewindFilesParams>;
export type SetMcpServersCommand = BridgeCommand<"mcp/set", SetMcpServersParams>;

export type AnyBridgeCommand =
  | InitializeCommand
  | SessionStartCommand
  | SessionResumeCommand
  | SessionCloseCommand
  | RewindFilesCommand
  | MessageSendCommand
  | MessageInterruptCommand
  | PermissionRespondCommand
  | ModelListCommand
  | ModelSetCommand
  | CommandListCommand
  | McpStatusCommand
  | SetMcpServersCommand;

// ============================================================================
// Stdout Events (Bridge -> Tauri)
// ============================================================================

export type EventType =
  | "session/started"
  | "session/closed"
  | "message/delta"
  | "message/complete"
  | "tool/started"
  | "tool/progress"
  | "tool/completed"
  | "permission/request"
  | "result"
  | "error"
  | "response";

export type BridgeEvent<T extends EventType = EventType, P = unknown> = {
  type: T;
  sessionId: string;
  workspaceId: string;
  timestamp: number;
  payload: P;
};

// Event payload types
export type SessionStartedPayload = {
  model: string;
  tools: string[];
  cwd: string;
  claudeCodeVersion: string;
  permissionMode: PermissionMode;
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
  suggestions?: PermissionUpdate[];
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

export type ResponsePayload = {
  id: number;
  result?: unknown;
  error?: string;
};

// Type-safe event definitions
export type SessionStartedEvent = BridgeEvent<
  "session/started",
  SessionStartedPayload
>;
export type SessionClosedEvent = BridgeEvent<
  "session/closed",
  SessionClosedPayload
>;
export type MessageDeltaEvent = BridgeEvent<
  "message/delta",
  MessageDeltaPayload
>;
export type MessageCompleteEvent = BridgeEvent<
  "message/complete",
  MessageCompletePayload
>;
export type ToolStartedEvent = BridgeEvent<"tool/started", ToolStartedPayload>;
export type ToolProgressEvent = BridgeEvent<
  "tool/progress",
  ToolProgressPayload
>;
export type ToolCompletedEvent = BridgeEvent<
  "tool/completed",
  ToolCompletedPayload
>;
export type PermissionRequestEvent = BridgeEvent<
  "permission/request",
  PermissionRequestPayload
>;
export type ResultEvent = BridgeEvent<"result", ResultPayload>;
export type ErrorEvent = BridgeEvent<"error", ErrorPayload>;
export type ResponseEvent = BridgeEvent<"response", ResponsePayload>;

export type AnyBridgeEvent =
  | SessionStartedEvent
  | SessionClosedEvent
  | MessageDeltaEvent
  | MessageCompleteEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | PermissionRequestEvent
  | ResultEvent
  | ErrorEvent
  | ResponseEvent;

// ============================================================================
// Session State
// ============================================================================

export type SessionState = {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  query: Query | null;
  /** Function to push a new user message to the session */
  pushMessage: ((message: SDKUserMessage) => void) | null;
  /** Function to close the input stream */
  closeInput: (() => void) | null;
  createdAt: number;
  status: "starting" | "active" | "closing" | "closed";
};

// ============================================================================
// Pending Permission Request
// ============================================================================

export type PendingPermission = {
  toolUseId: string;
  sessionId: string;
  workspaceId: string;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};
