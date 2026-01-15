import type { WorkspaceInfo } from "../types";
import {
  type UnifiedApprovalRequest,
  isClaudeApproval,
  getApprovalId,
} from "../hooks/useThreadsReducer";

type ApprovalToastsProps = {
  approvals: UnifiedApprovalRequest[];
  workspaces: WorkspaceInfo[];
  onDecision: (request: UnifiedApprovalRequest, decision: "accept" | "decline") => void;
};

function getApprovalMethod(request: UnifiedApprovalRequest): string {
  if (isClaudeApproval(request)) {
    return request.tool_name;
  }
  return request.method;
}

function getApprovalParams(request: UnifiedApprovalRequest): Record<string, unknown> {
  if (isClaudeApproval(request)) {
    return request.tool_input;
  }
  return request.params;
}

export function ApprovalToasts({
  approvals,
  workspaces,
  onDecision,
}: ApprovalToastsProps) {
  if (!approvals.length) {
    return null;
  }

  const workspaceLabels = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.name]),
  );

  return (
    <div className="approval-toasts" role="region" aria-live="assertive">
      {approvals.map((request) => {
        const workspaceName = workspaceLabels.get(request.workspace_id);
        const method = getApprovalMethod(request);
        const params = getApprovalParams(request);
        const key = getApprovalId(request);

        return (
          <div key={key} className="approval-toast" role="alert">
            <div className="approval-toast-header">
              <div className="approval-toast-title">
                {isClaudeApproval(request) ? "Permission needed" : "Approval needed"}
              </div>
              {workspaceName ? (
                <div className="approval-toast-workspace">{workspaceName}</div>
              ) : null}
            </div>
            <div className="approval-toast-method">{method}</div>
            <div className="approval-toast-body">
              {JSON.stringify(params, null, 2)}
            </div>
            {isClaudeApproval(request) && request.decision_reason && (
              <div className="approval-toast-reason">{request.decision_reason}</div>
            )}
            <div className="approval-toast-actions">
              <button
                className="secondary"
                onClick={() => onDecision(request, "decline")}
              >
                Decline
              </button>
              <button
                className="primary"
                onClick={() => onDecision(request, "accept")}
              >
                Approve
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
