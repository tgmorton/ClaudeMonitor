import * as readline from "readline";
import type {
  AnyBridgeCommand,
  InitializeParams,
  SessionStartParams,
  SessionResumeParams,
  SessionCloseParams,
  MessageSendParams,
  MessageInterruptParams,
  PermissionRespondParams,
  ModelSetParams,
  ModelListParams,
  CommandListParams,
  McpStatusParams,
  RewindFilesParams,
  SetMcpServersParams,
} from "./types.js";
import { emitResponse, emitError, log, logError } from "./event-emitter.js";
import { sessionManager } from "./session-manager.js";
import { permissionHandler } from "./permission-handler.js";

// Bridge state
let initialized = false;
const clientInfo: { name: string; version: string } = {
  name: "unknown",
  version: "0.0.0",
};

/**
 * Handle an incoming command.
 */
async function handleCommand(command: AnyBridgeCommand): Promise<unknown> {
  const { method, params } = command;

  switch (method) {
    case "initialize":
      return handleInitialize(params as InitializeParams);

    case "session/start":
      return handleSessionStart(params as SessionStartParams);

    case "session/resume":
      return handleSessionResume(params as SessionResumeParams);

    case "session/close":
      return handleSessionClose(params as SessionCloseParams);

    case "message/send":
      return handleMessageSend(params as MessageSendParams);

    case "message/interrupt":
      return handleMessageInterrupt(params as MessageInterruptParams);

    case "permission/respond":
      return handlePermissionRespond(params as PermissionRespondParams);

    case "model/list":
      return handleModelList(params as ModelListParams);

    case "model/set":
      return handleModelSet(params as ModelSetParams);

    case "command/list":
      return handleCommandList(params as CommandListParams);

    case "mcp/status":
      return handleMcpStatus(params as McpStatusParams);

    case "session/rewind":
      return handleRewindFiles(params as RewindFilesParams);

    case "mcp/set":
      return handleSetMcpServers(params as SetMcpServersParams);

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ============================================================================
// Command Handlers
// ============================================================================

function handleInitialize(params: InitializeParams): { capabilities: string[] } {
  if (initialized) {
    throw new Error("Bridge already initialized");
  }

  clientInfo.name = params.clientInfo.name;
  clientInfo.version = params.clientInfo.version;
  initialized = true;

  log(`Bridge initialized by ${clientInfo.name} v${clientInfo.version}`);

  return {
    capabilities: [
      "session/start",
      "session/resume",
      "session/close",
      "session/rewind",
      "message/send",
      "message/interrupt",
      "permission/respond",
      "model/list",
      "model/set",
      "command/list",
      "mcp/status",
      "mcp/set",
    ],
  };
}

async function handleSessionStart(
  params: SessionStartParams
): Promise<{ sessionId: string }> {
  if (!initialized) {
    throw new Error("Bridge not initialized");
  }

  const {
    workspaceId,
    cwd,
    model,
    permissionMode,
    claudeCodeBin,
    enableFileCheckpointing,
    mcpServers,
    plugins,
    agents,
  } = params;
  const sessionId = await sessionManager.startSession(workspaceId, cwd, {
    model,
    permissionMode,
    claudeCodeBin,
    enableFileCheckpointing,
    mcpServers,
    plugins,
    agents,
  });

  return { sessionId };
}

async function handleSessionResume(
  params: SessionResumeParams
): Promise<{ success: boolean }> {
  if (!initialized) {
    throw new Error("Bridge not initialized");
  }

  const { workspaceId, sessionId, cwd, claudeCodeBin } = params;
  await sessionManager.resumeSession(workspaceId, sessionId, cwd, {
    claudeCodeBin,
  });

  return { success: true };
}

async function handleSessionClose(
  params: SessionCloseParams
): Promise<{ success: boolean }> {
  const { sessionId } = params;
  await sessionManager.closeSession(sessionId);
  return { success: true };
}

async function handleMessageSend(
  params: MessageSendParams
): Promise<{ success: boolean }> {
  if (!initialized) {
    throw new Error("Bridge not initialized");
  }

  const { sessionId, message, images, messageId } = params;
  await sessionManager.sendMessage(sessionId, message, images, messageId);
  return { success: true };
}

async function handleMessageInterrupt(
  params: MessageInterruptParams
): Promise<{ success: boolean }> {
  const { sessionId } = params;
  await sessionManager.interrupt(sessionId);
  return { success: true };
}

function handlePermissionRespond(
  params: PermissionRespondParams
): { success: boolean } {
  const { toolUseId, decision, message, updatedPermissions } = params;
  const success = permissionHandler.respond(
    toolUseId,
    decision,
    message,
    updatedPermissions
  );
  return { success };
}

async function handleModelList(
  params: ModelListParams
): Promise<{ models: unknown[] }> {
  if (!params.sessionId) {
    throw new Error("sessionId required for model listing");
  }
  const models = await sessionManager.listModels(params.sessionId);
  return { models };
}

async function handleCommandList(
  params: CommandListParams
): Promise<{ commands: unknown[] }> {
  const commands = await sessionManager.listCommands(params.sessionId);
  return { commands };
}

async function handleMcpStatus(
  params: McpStatusParams
): Promise<{ servers: unknown[] }> {
  const servers = await sessionManager.getMcpStatus(params.sessionId);
  return { servers };
}

async function handleModelSet(
  params: ModelSetParams
): Promise<{ success: boolean }> {
  const { sessionId, model } = params;
  const session = sessionManager.getSession(sessionId);
  if (!session?.query) {
    throw new Error(`Session not found or not active: ${sessionId}`);
  }
  await session.query.setModel(model);
  return { success: true };
}

// Phase 3: Rewind files handler
async function handleRewindFiles(
  params: RewindFilesParams
): Promise<{
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}> {
  const { sessionId, userMessageId, dryRun } = params;
  return sessionManager.rewindFiles(sessionId, userMessageId, dryRun);
}

// Phase 4: Set MCP servers handler
async function handleSetMcpServers(
  params: SetMcpServersParams
): Promise<{
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}> {
  const { sessionId, servers } = params;
  return sessionManager.setMcpServers(sessionId, servers);
}

// ============================================================================
// Main Loop
// ============================================================================

async function main(): Promise<void> {
  log("Claude Bridge starting...");

  // Set up stdin reader
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    permissionHandler.cancelAll();
    await sessionManager.closeAll();
    rl.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Process commands from stdin
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let command: AnyBridgeCommand;
    try {
      command = JSON.parse(line);
    } catch (error) {
      logError("Failed to parse command", error);
      emitError("", "", {
        code: "PARSE_ERROR",
        message: `Failed to parse command: ${error instanceof Error ? error.message : "Unknown error"}`,
        recoverable: true,
      });
      continue;
    }

    // Validate command structure
    if (typeof command.id !== "number" || typeof command.method !== "string") {
      logError("Invalid command structure", command);
      emitError("", "", {
        code: "INVALID_COMMAND",
        message: "Command must have numeric 'id' and string 'method'",
        recoverable: true,
      });
      continue;
    }

    // Handle command
    try {
      const result = await handleCommand(command);
      emitResponse("", "", {
        id: command.id,
        result,
      });
    } catch (error) {
      logError(`Error handling command ${command.method}`, error);
      emitResponse("", "", {
        id: command.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // stdin closed
  log("stdin closed, shutting down");
  await shutdown();
}

// Run
main().catch((error) => {
  logError("Fatal error", error);
  process.exit(1);
});
