import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ClaudeBridgeEvent,
  ClaudeApprovalRequest,
  ClaudeMessageDeltaEvent,
  ClaudeMessageCompleteEvent,
  ClaudeResultEvent,
  ClaudeSessionStartedEvent,
  ClaudeSessionClosedEvent,
  ClaudeToolStartedEvent,
  ClaudeToolProgressEvent,
  ClaudeToolCompletedEvent,
  ClaudeErrorEvent,
} from "../types";

export type ClaudeEventHandlers = {
  onSessionStarted?: (event: ClaudeSessionStartedEvent) => void;
  onSessionClosed?: (event: ClaudeSessionClosedEvent) => void;
  onApprovalRequest?: (request: ClaudeApprovalRequest) => void;
  onMessageDelta?: (event: ClaudeMessageDeltaEvent) => void;
  onMessageComplete?: (event: ClaudeMessageCompleteEvent) => void;
  onToolStarted?: (event: ClaudeToolStartedEvent) => void;
  onToolProgress?: (event: ClaudeToolProgressEvent) => void;
  onToolCompleted?: (event: ClaudeToolCompletedEvent) => void;
  onResult?: (event: ClaudeResultEvent) => void;
  onError?: (event: ClaudeErrorEvent) => void;
  onBridgeConnected?: (workspaceId: string, payload: unknown) => void;
  onBridgeStderr?: (workspaceId: string, message: string) => void;
  onRawEvent?: (event: ClaudeBridgeEvent) => void;
};

/**
 * Hook to listen for Claude bridge events from the Tauri backend.
 * Event name: "claude-event" with payload BridgeEvent.
 */
export function useClaudeEvents(handlers: ClaudeEventHandlers) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let canceled = false;

    // Listen to "claude-event" from Tauri backend (Rust ClaudeEvent struct)
    listen<ClaudeBridgeEvent>("claude-event", (tauriEvent) => {
      const message = tauriEvent.payload;
      handlers.onRawEvent?.(message);

      switch (message.type) {
        case "session/started":
          handlers.onSessionStarted?.(message);
          break;

        case "session/closed":
          handlers.onSessionClosed?.(message);
          break;

        case "permission/request":
          handlers.onApprovalRequest?.({
            workspace_id: message.workspaceId,
            session_id: message.sessionId,
            tool_use_id: message.payload.toolUseId,
            tool_name: message.payload.toolName,
            tool_input: message.payload.input,
            suggestions: message.payload.suggestions,
            blocked_path: message.payload.blockedPath,
            decision_reason: message.payload.decisionReason,
          });
          break;

        case "message/delta":
          handlers.onMessageDelta?.(message);
          break;

        case "message/complete":
          handlers.onMessageComplete?.(message);
          break;

        case "tool/started":
          handlers.onToolStarted?.(message);
          break;

        case "tool/progress":
          handlers.onToolProgress?.(message);
          break;

        case "tool/completed":
          handlers.onToolCompleted?.(message);
          break;

        case "result":
          handlers.onResult?.(message);
          break;

        case "error":
          handlers.onError?.(message);
          break;

        case "bridge/connected":
          handlers.onBridgeConnected?.(message.workspaceId, message.payload);
          break;

        case "bridge/stderr":
          handlers.onBridgeStderr?.(message.workspaceId, message.payload.message);
          break;
      }
    }).then((handler) => {
      if (canceled) {
        try {
          handler();
        } catch {
          // Ignore unlisten errors when already removed.
        }
      } else {
        unlisten = handler;
      }
    });

    return () => {
      canceled = true;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // Ignore unlisten errors when already removed.
        }
      }
    };
  }, [handlers]);
}
