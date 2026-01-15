import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type Query,
  type PermissionMode,
  type ModelInfo,
  type SlashCommand,
  type McpServerStatus,
} from "@anthropic-ai/claude-agent-sdk";
import { promises as fs } from "fs";
import path from "path";
import type {
  SessionState,
  McpServerConfig,
  PluginConfig,
  AgentDefinition,
  RewindFilesResult,
  SetMcpServersResult,
} from "./types.js";
import {
  emitSessionStarted,
  emitSessionClosed,
  emitMessageDelta,
  emitMessageComplete,
  emitToolProgress,
  emitResult,
  emitError,
  log,
  logError,
} from "./event-emitter.js";
import { permissionHandler } from "./permission-handler.js";

/**
 * Creates an async iterable input stream for multi-turn conversations.
 * Returns both the iterable and a function to push new messages.
 */
function createInputStream(): {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (message: SDKUserMessage) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolveNext: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;

  const push = (message: SDKUserMessage) => {
    if (closed) return;
    if (resolveNext) {
      resolveNext({ value: message, done: false });
      resolveNext = null;
    } else {
      queue.push(message);
    }
  };

  const close = () => {
    closed = true;
    if (resolveNext) {
      resolveNext({ value: undefined as unknown as SDKUserMessage, done: true });
      resolveNext = null;
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          if (closed) {
            return { value: undefined as unknown as SDKUserMessage, done: true };
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };

  return { iterable, push, close };
}

/**
 * Manages Claude SDK sessions.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private workspaceToSession = new Map<string, string>(); // workspaceId -> sessionId

  /**
   * Start a new session for a workspace.
   */
  async startSession(
    workspaceId: string,
    cwd: string,
    options: {
      model?: string;
      permissionMode?: PermissionMode;
      claudeCodeBin?: string;
      // Phase 3
      enableFileCheckpointing?: boolean;
      // Phase 4
      mcpServers?: Record<string, McpServerConfig>;
      plugins?: PluginConfig[];
      agents?: Record<string, AgentDefinition>;
    } = {}
  ): Promise<string> {
    log(`Starting session for workspace: ${workspaceId}, cwd: ${cwd}`);

    // Check if workspace already has an active session
    const existingSessionId = this.workspaceToSession.get(workspaceId);
    if (existingSessionId) {
      const existing = this.sessions.get(existingSessionId);
      if (existing && existing.status === "active") {
        throw new Error(
          `Workspace ${workspaceId} already has an active session: ${existingSessionId}`
        );
      }
    }

    // Create input stream for multi-turn conversation
    const { iterable, push, close } = createInputStream();

    // Create temporary session state (sessionId will be set when we get init message)
    const tempSessionId = `pending-${Date.now()}`;
    const sessionState: SessionState = {
      sessionId: tempSessionId,
      workspaceId,
      cwd,
      query: null,
      pushMessage: push,
      closeInput: close,
      createdAt: Date.now(),
      status: "starting",
    };
    this.sessions.set(tempSessionId, sessionState);

    try {
      // Create the query with streaming input
      const q = query({
        prompt: iterable,
        options: {
          cwd,
          model: options.model,
          permissionMode: options.permissionMode ?? "default",
          pathToClaudeCodeExecutable: options.claudeCodeBin || undefined,
          canUseTool: permissionHandler.createCallback(() => sessionState.sessionId, workspaceId),
          includePartialMessages: true,
          persistSession: true,
          // Phase 3: File checkpointing
          enableFileCheckpointing: options.enableFileCheckpointing,
          // Phase 4: Extensibility
          mcpServers: options.mcpServers,
          plugins: options.plugins,
          agents: options.agents,
        },
      });

      sessionState.query = q;

      // Process messages in background
      this.processMessages(q, sessionState, workspaceId);

      return tempSessionId;
    } catch (error) {
      // Clean up on error
      this.sessions.delete(tempSessionId);
      logError(`Failed to start session for workspace: ${workspaceId}`, error);
      throw error;
    }
  }

  /**
   * Resume an existing session.
   */
  async resumeSession(
    workspaceId: string,
    sessionId: string,
    cwd: string,
    options: {
      claudeCodeBin?: string;
    } = {}
  ): Promise<void> {
    log(`Resuming session: ${sessionId} for workspace: ${workspaceId}`);

    // Check if session is already active
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!;
      if (existing.status === "active") {
        throw new Error(`Session ${sessionId} is already active`);
      }
    }

    // Create input stream for multi-turn conversation
    const { iterable, push, close } = createInputStream();

    const sessionState: SessionState = {
      sessionId,
      workspaceId,
      cwd,
      query: null,
      pushMessage: push,
      closeInput: close,
      createdAt: Date.now(),
      status: "starting",
    };
    this.sessions.set(sessionId, sessionState);
    this.workspaceToSession.set(workspaceId, sessionId);

    try {
      const q = query({
        prompt: iterable,
        options: {
          cwd,
          resume: sessionId,
          pathToClaudeCodeExecutable: options.claudeCodeBin || undefined,
          canUseTool: permissionHandler.createCallback(() => sessionId, workspaceId),
          includePartialMessages: true,
          persistSession: true,
        },
      });

      sessionState.query = q;

      // Process messages in background
      this.processMessages(q, sessionState, workspaceId);
    } catch (error) {
      this.sessions.delete(sessionId);
      this.workspaceToSession.delete(workspaceId);
      logError(`Failed to resume session: ${sessionId}`, error);
      throw error;
    }
  }

  /**
   * Send a message to a session.
   */
  async sendMessage(
    sessionId: string,
    message: string,
    images?: string[],
    messageId?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status !== "active" && session.status !== "starting") {
      throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
    }
    if (!session.pushMessage) {
      throw new Error(`Session ${sessionId} has no message handler`);
    }

    log(`Sending message to session: ${sessionId}`);

    // Build message content
    const content: Array<{ type: string; text?: string; source?: unknown }> = [
      { type: "text", text: message },
    ];

    // Add images if provided
    if (images && images.length > 0) {
      for (const imagePath of images) {
        const ext = path.extname(imagePath).toLowerCase();
        const mediaType =
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".bmp"
                  ? "image/bmp"
                  : ext === ".tif" || ext === ".tiff"
                    ? "image/tiff"
                    : "image/png";
        const buffer = await fs.readFile(imagePath);
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: buffer.toString("base64"),
          },
        });
      }
    }

    const userMessage: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content: content.length === 1 ? message : content,
      },
      parent_tool_use_id: null,
      uuid: messageId,
      session_id: session.sessionId,
    };

    session.pushMessage(userMessage);
  }

  /**
   * Interrupt a session's current processing.
   */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.query) {
      throw new Error(`Session ${sessionId} has no active query`);
    }

    log(`Interrupting session: ${sessionId}`);
    await session.query.interrupt();
  }

  /**
   * Close a session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log(`Session not found for close: ${sessionId}`);
      return;
    }

    log(`Closing session: ${sessionId}`);
    session.status = "closing";

    // Cancel pending permissions
    permissionHandler.cancelForSession(sessionId);

    // Close the input stream
    if (session.closeInput) {
      session.closeInput();
    }

    // Remove from maps
    this.sessions.delete(sessionId);
    if (this.workspaceToSession.get(session.workspaceId) === sessionId) {
      this.workspaceToSession.delete(session.workspaceId);
    }

    emitSessionClosed(sessionId, session.workspaceId, { reason: "user" });
  }

  /**
   * Get list of available models.
   * Requires an active session to query the SDK.
   */
  async listModels(sessionId: string): Promise<ModelInfo[]> {
    const session = this.sessions.get(sessionId);
    if (!session?.query) {
      throw new Error(`Session not found or inactive: ${sessionId}`);
    }
    return session.query.supportedModels();
  }

  /**
   * Get list of available slash commands (skills).
   */
  async listCommands(sessionId?: string): Promise<SlashCommand[]> {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session?.query) {
        return session.query.supportedCommands();
      }
    }
    // No commands available without an active session
    return [];
  }

  /**
   * Get MCP server status for a session.
   */
  async getMcpStatus(sessionId: string): Promise<McpServerStatus[]> {
    const session = this.sessions.get(sessionId);
    if (!session?.query) {
      throw new Error(`Session not found or inactive: ${sessionId}`);
    }
    return session.query.mcpServerStatus();
  }

  /**
   * Rewind files to a previous state (Phase 3).
   * Requires enableFileCheckpointing to have been set on session start.
   */
  async rewindFiles(
    sessionId: string,
    userMessageId: string,
    dryRun?: boolean
  ): Promise<RewindFilesResult> {
    const session = this.sessions.get(sessionId);
    if (!session?.query) {
      throw new Error(`Session not found or inactive: ${sessionId}`);
    }
    try {
      const result = await session.query.rewindFiles(userMessageId, { dryRun });
      return {
        canRewind: result.canRewind,
        error: result.error,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
      };
    } catch (error) {
      return {
        canRewind: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Dynamically update MCP servers for a session (Phase 4).
   */
  async setMcpServers(
    sessionId: string,
    servers: Record<string, McpServerConfig>
  ): Promise<SetMcpServersResult> {
    const session = this.sessions.get(sessionId);
    if (!session?.query) {
      throw new Error(`Session not found or inactive: ${sessionId}`);
    }
    const result = await session.query.setMcpServers(servers);
    return {
      added: result.added,
      removed: result.removed,
      errors: result.errors,
    };
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session ID for a workspace.
   */
  getSessionForWorkspace(workspaceId: string): string | undefined {
    return this.workspaceToSession.get(workspaceId);
  }

  /**
   * Check if a session exists and is active.
   */
  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.status === "active";
  }

  /**
   * Process messages from the query async generator.
   */
  private async processMessages(
    q: Query,
    sessionState: SessionState,
    workspaceId: string
  ): Promise<void> {
    try {
      for await (const msg of q) {
        this.handleMessage(msg, sessionState, workspaceId);
      }
    } catch (error) {
      logError(`Error processing messages for session: ${sessionState.sessionId}`, error);
      emitError(sessionState.sessionId, workspaceId, {
        code: "MESSAGE_PROCESSING_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
        recoverable: false,
      });
    } finally {
      // Clean up session
      if (this.sessions.has(sessionState.sessionId)) {
        sessionState.status = "closed";
        this.sessions.delete(sessionState.sessionId);
        if (this.workspaceToSession.get(workspaceId) === sessionState.sessionId) {
          this.workspaceToSession.delete(workspaceId);
        }
        emitSessionClosed(sessionState.sessionId, workspaceId, { reason: "completed" });
      }
    }
  }

  /**
   * Handle a single SDK message.
   */
  private handleMessage(
    msg: SDKMessage,
    sessionState: SessionState,
    workspaceId: string
  ): void {
    const sessionId = msg.session_id ?? sessionState.sessionId;

    // Update session ID if this is the first real message
    if (sessionState.sessionId.startsWith("pending-") && msg.session_id) {
      const oldId = sessionState.sessionId;
      sessionState.sessionId = msg.session_id;
      this.sessions.delete(oldId);
      this.sessions.set(msg.session_id, sessionState);
      this.workspaceToSession.set(workspaceId, msg.session_id);

      // Update permission handler callback to use real session ID
      // Note: This requires the permission handler to handle the ID change
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionState.status = "active";
          emitSessionStarted(sessionId, workspaceId, {
            model: msg.model,
            tools: msg.tools,
            cwd: msg.cwd,
            claudeCodeVersion: msg.claude_code_version,
            permissionMode: msg.permissionMode,
            mcpServers: msg.mcp_servers,
          });
        }
        break;

      case "stream_event":
        emitMessageDelta(sessionId, workspaceId, {
          event: msg.event,
          parentToolUseId: msg.parent_tool_use_id,
          uuid: msg.uuid,
        });
        break;

      case "assistant":
        emitMessageComplete(sessionId, workspaceId, {
          uuid: msg.uuid,
          message: msg.message,
          parentToolUseId: msg.parent_tool_use_id,
          error: msg.error,
        });
        break;

      case "tool_progress":
        emitToolProgress(sessionId, workspaceId, {
          toolName: msg.tool_name,
          toolUseId: msg.tool_use_id,
          elapsedSeconds: msg.elapsed_time_seconds,
          parentToolUseId: msg.parent_tool_use_id,
        });
        break;

      case "result":
        emitResult(sessionId, workspaceId, {
          success: msg.subtype === "success",
          subtype: msg.subtype,
          result: msg.subtype === "success" ? msg.result : undefined,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          totalCostUsd: msg.total_cost_usd,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
          },
          errors: msg.subtype !== "success" ? msg.errors : undefined,
        });
        break;

      case "user":
        // User messages are replayed during resume - we can ignore or log them
        log(`Received user message replay: ${msg.uuid}`);
        break;

      case "auth_status":
        if (msg.error) {
          emitError(sessionId, workspaceId, {
            code: "AUTH_ERROR",
            message: msg.error,
            recoverable: false,
          });
        }
        break;

      default:
        log(`Unhandled message type: ${(msg as { type: string }).type}`);
    }
  }

  /**
   * Close all sessions.
   */
  async closeAll(): Promise<void> {
    log("Closing all sessions");
    for (const sessionId of this.sessions.keys()) {
      await this.closeSession(sessionId);
    }
  }
}

// Global session manager instance
export const sessionManager = new SessionManager();
