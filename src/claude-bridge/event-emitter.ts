import type {
  EventType,
  BridgeEvent,
  SessionStartedPayload,
  SessionClosedPayload,
  MessageDeltaPayload,
  MessageCompletePayload,
  ToolStartedPayload,
  ToolProgressPayload,
  ToolCompletedPayload,
  PermissionRequestPayload,
  ResultPayload,
  ErrorPayload,
  ResponsePayload,
} from "./types.js";

/**
 * Emit a JSON event to stdout for the Tauri backend to receive.
 * Events are newline-delimited JSON.
 */
function emit<T extends EventType>(
  type: T,
  sessionId: string,
  workspaceId: string,
  payload: unknown
): void {
  const event: BridgeEvent<T> = {
    type,
    sessionId,
    workspaceId,
    timestamp: Date.now(),
    payload,
  } as BridgeEvent<T>;

  try {
    const json = JSON.stringify(event);
    process.stdout.write(json + "\n");
  } catch (error) {
    // If we can't serialize the event, emit an error event instead
    const errorEvent: BridgeEvent<"error", ErrorPayload> = {
      type: "error",
      sessionId,
      workspaceId,
      timestamp: Date.now(),
      payload: {
        code: "SERIALIZATION_ERROR",
        message:
          error instanceof Error ? error.message : "Failed to serialize event",
        recoverable: true,
      },
    };
    process.stdout.write(JSON.stringify(errorEvent) + "\n");
  }
}

// ============================================================================
// Typed emit helpers
// ============================================================================

export function emitSessionStarted(
  sessionId: string,
  workspaceId: string,
  payload: SessionStartedPayload
): void {
  emit("session/started", sessionId, workspaceId, payload);
}

export function emitSessionClosed(
  sessionId: string,
  workspaceId: string,
  payload: SessionClosedPayload
): void {
  emit("session/closed", sessionId, workspaceId, payload);
}

export function emitMessageDelta(
  sessionId: string,
  workspaceId: string,
  payload: MessageDeltaPayload
): void {
  emit("message/delta", sessionId, workspaceId, payload);
}

export function emitMessageComplete(
  sessionId: string,
  workspaceId: string,
  payload: MessageCompletePayload
): void {
  emit("message/complete", sessionId, workspaceId, payload);
}

export function emitToolStarted(
  sessionId: string,
  workspaceId: string,
  payload: ToolStartedPayload
): void {
  emit("tool/started", sessionId, workspaceId, payload);
}

export function emitToolProgress(
  sessionId: string,
  workspaceId: string,
  payload: ToolProgressPayload
): void {
  emit("tool/progress", sessionId, workspaceId, payload);
}

export function emitToolCompleted(
  sessionId: string,
  workspaceId: string,
  payload: ToolCompletedPayload
): void {
  emit("tool/completed", sessionId, workspaceId, payload);
}

export function emitPermissionRequest(
  sessionId: string,
  workspaceId: string,
  payload: PermissionRequestPayload
): void {
  emit("permission/request", sessionId, workspaceId, payload);
}

export function emitResult(
  sessionId: string,
  workspaceId: string,
  payload: ResultPayload
): void {
  emit("result", sessionId, workspaceId, payload);
}

export function emitError(
  sessionId: string,
  workspaceId: string,
  payload: ErrorPayload
): void {
  emit("error", sessionId, workspaceId, payload);
}

export function emitResponse(
  sessionId: string,
  workspaceId: string,
  payload: ResponsePayload
): void {
  emit("response", sessionId, workspaceId, payload);
}

// ============================================================================
// Log to stderr (for debugging, won't interfere with stdout events)
// ============================================================================

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${message}`, ...args);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  if (error instanceof Error) {
    console.error(`[${timestamp}] ERROR: ${message}`, error.message, error.stack);
  } else {
    console.error(`[${timestamp}] ERROR: ${message}`, error);
  }
}
