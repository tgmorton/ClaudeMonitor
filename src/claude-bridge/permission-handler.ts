import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { PendingPermission } from "./types.js";
import { emitPermissionRequest, log, logError } from "./event-emitter.js";

// Default permission request timeout (5 minutes)
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Manages pending permission requests and creates canUseTool callbacks.
 */
export class PermissionHandler {
  private pending = new Map<string, PendingPermission>();
  private timeoutMs: number;

  constructor(timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Create a canUseTool callback for a specific session/workspace.
   */
  createCallback(getSessionId: () => string, workspaceId: string): CanUseTool {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        blockedPath?: string;
        decisionReason?: string;
        toolUseID: string;
        agentID?: string;
      }
    ): Promise<PermissionResult> => {
      const sessionId = getSessionId();
      const { toolUseID, suggestions, blockedPath, decisionReason, agentID, signal } =
        options;

      log(
        `Permission request for tool: ${toolName}, toolUseId: ${toolUseID}, session: ${sessionId}`
      );

      // Emit permission request event to Tauri
      emitPermissionRequest(sessionId, workspaceId, {
        toolName,
        toolUseId: toolUseID,
        input,
        suggestions,
        blockedPath,
        decisionReason,
        agentId: agentID,
      });

      // Create promise that will be resolved when respond() is called
      return new Promise<PermissionResult>((resolve, reject) => {
        // Set up timeout
        const timeoutId = setTimeout(() => {
          const pending = this.pending.get(toolUseID);
          if (pending) {
            this.pending.delete(toolUseID);
            log(`Permission request timed out for toolUseId: ${toolUseID}`);
            // Auto-deny on timeout
            resolve({
              behavior: "deny",
              message: "Permission request timed out",
              toolUseID,
            });
          }
        }, this.timeoutMs);

        // Handle abort signal
        const abortHandler = () => {
          const pending = this.pending.get(toolUseID);
          if (pending) {
            clearTimeout(pending.timeoutId);
            this.pending.delete(toolUseID);
            reject(new Error("Permission request aborted"));
          }
        };
        signal.addEventListener("abort", abortHandler, { once: true });

        // Store pending request
        this.pending.set(toolUseID, {
          toolUseId: toolUseID,
          sessionId,
          workspaceId,
          resolve: (result) => {
            signal.removeEventListener("abort", abortHandler);
            resolve(result);
          },
          reject: (error) => {
            signal.removeEventListener("abort", abortHandler);
            reject(error);
          },
          timeoutId,
        });
      });
    };
  }

  /**
   * Respond to a pending permission request.
   */
  respond(
    toolUseId: string,
    decision: "allow" | "deny",
    message?: string,
    updatedPermissions?: PermissionUpdate[]
  ): boolean {
    const pending = this.pending.get(toolUseId);
    if (!pending) {
      logError(`No pending permission request found for toolUseId: ${toolUseId}`);
      return false;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeoutId);
    this.pending.delete(toolUseId);

    log(`Responding to permission request: ${toolUseId} with decision: ${decision}`);

    // Resolve the promise with the decision
    if (decision === "allow") {
      pending.resolve({
        behavior: "allow",
        updatedPermissions,
        toolUseID: toolUseId,
      });
    } else {
      pending.resolve({
        behavior: "deny",
        message: message ?? "Permission denied by user",
        toolUseID: toolUseId,
      });
    }

    return true;
  }

  /**
   * Check if there's a pending permission request for a tool use ID.
   */
  hasPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  /**
   * Get all pending permission requests for a session.
   */
  getPendingForSession(sessionId: string): PendingPermission[] {
    return Array.from(this.pending.values()).filter(
      (p) => p.sessionId === sessionId
    );
  }

  /**
   * Cancel all pending permission requests for a session.
   */
  cancelForSession(sessionId: string): void {
    for (const [toolUseId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("Session closed"));
        this.pending.delete(toolUseId);
      }
    }
  }

  /**
   * Cancel all pending permission requests.
   */
  cancelAll(): void {
    for (const [toolUseId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Bridge shutting down"));
      this.pending.delete(toolUseId);
    }
  }

  /**
   * Get the number of pending permission requests.
   */
  get pendingCount(): number {
    return this.pending.size;
  }
}

// Global permission handler instance
export const permissionHandler = new PermissionHandler();
