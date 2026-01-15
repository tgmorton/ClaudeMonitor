import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  ClaudeDoctorResult,
  CodexDoctorResult,
  SessionEntry,
  ConversationItem,
  WorkspaceInfo,
  WorkspaceSettings,
} from "../types";
import type {
  GitFileDiff,
  GitFileStatus,
  GitHubIssuesResponse,
  GitLogResponse,
  ReviewTarget,
} from "../types";

export async function pickWorkspacePath(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

export async function pickImageFiles(): Promise<string[]> {
  const selection = await open({
    multiple: true,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"],
      },
    ],
  });
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

export async function addWorkspace(
  path: string,
  codex_bin: string | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_workspace", { path, codex_bin });
}

export async function addWorktree(
  parentId: string,
  branch: string,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_worktree", { parentId, branch });
}

export async function updateWorkspaceSettings(
  id: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("update_workspace_settings", { id, settings });
}

export async function updateWorkspaceCodexBin(
  id: string,
  codex_bin: string | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("update_workspace_codex_bin", { id, codex_bin });
}

export async function removeWorkspace(id: string): Promise<void> {
  return invoke("remove_workspace", { id });
}

export async function removeWorktree(id: string): Promise<void> {
  return invoke("remove_worktree", { id });
}

export async function connectWorkspace(id: string): Promise<void> {
  return invoke("connect_workspace", { id });
}

export async function startThread(workspaceId: string) {
  return invoke<any>("start_thread", { workspaceId });
}

export async function sendUserMessage(
  workspaceId: string,
  threadId: string,
  text: string,
  options?: {
    model?: string | null;
    effort?: string | null;
    accessMode?: "read-only" | "current" | "full-access";
    images?: string[];
  },
) {
  return invoke("send_user_message", {
    workspaceId,
    threadId,
    text,
    model: options?.model ?? null,
    effort: options?.effort ?? null,
    accessMode: options?.accessMode ?? null,
    images: options?.images ?? null,
  });
}

export async function interruptTurn(
  workspaceId: string,
  threadId: string,
  turnId: string,
) {
  return invoke("turn_interrupt", { workspaceId, threadId, turnId });
}

export async function startReview(
  workspaceId: string,
  threadId: string,
  target: ReviewTarget,
  delivery?: "inline" | "detached",
) {
  const payload: Record<string, unknown> = { workspaceId, threadId, target };
  if (delivery) {
    payload.delivery = delivery;
  }
  return invoke("start_review", payload);
}

export async function respondToServerRequest(
  workspaceId: string,
  requestId: number,
  decision: "accept" | "decline",
) {
  return invoke("respond_to_server_request", {
    workspaceId,
    requestId,
    result: { decision },
  });
}

export async function getGitStatus(workspace_id: string): Promise<{
  branchName: string;
  files: GitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
}> {
  return invoke("get_git_status", { workspaceId: workspace_id });
}

export async function getGitDiffs(
  workspace_id: string,
): Promise<GitFileDiff[]> {
  return invoke("get_git_diffs", { workspaceId: workspace_id });
}

export async function getGitLog(
  workspace_id: string,
  limit = 40,
): Promise<GitLogResponse> {
  return invoke("get_git_log", { workspaceId: workspace_id, limit });
}

export async function getGitRemote(workspace_id: string): Promise<string | null> {
  return invoke("get_git_remote", { workspaceId: workspace_id });
}

export async function getGitHubIssues(
  workspace_id: string,
): Promise<GitHubIssuesResponse> {
  return invoke("get_github_issues", { workspaceId: workspace_id });
}

export async function getModelList(workspaceId: string) {
  return invoke<any>("model_list", { workspaceId });
}

export async function getAccountRateLimits(workspaceId: string) {
  return invoke<any>("account_rate_limits", { workspaceId });
}

export async function getSkillsList(workspaceId: string) {
  return invoke<any>("skills_list", { workspaceId });
}

export async function getPromptsList(workspaceId: string) {
  return invoke<any>("prompts_list", { workspaceId });
}

export async function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("update_app_settings", { settings });
}

export async function runCodexDoctor(
  codexBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("codex_doctor", { codexBin });
}

export async function getWorkspaceFiles(workspaceId: string) {
  return invoke<string[]>("list_workspace_files", { workspaceId });
}

export async function listGitBranches(workspaceId: string) {
  return invoke<any>("list_git_branches", { workspaceId });
}

export async function checkoutGitBranch(workspaceId: string, name: string) {
  return invoke("checkout_git_branch", { workspaceId, name });
}

export async function createGitBranch(workspaceId: string, name: string) {
  return invoke("create_git_branch", { workspaceId, name });
}

export async function listThreads(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
) {
  return invoke<any>("list_threads", { workspaceId, cursor, limit });
}

export async function resumeThread(workspaceId: string, threadId: string) {
  return invoke<any>("resume_thread", { workspaceId, threadId });
}

export async function archiveThread(workspaceId: string, threadId: string) {
  return invoke<any>("archive_thread", { workspaceId, threadId });
}

// ============================================================================
// Claude Agent SDK Service Functions
// Commands match src-tauri/src/claude.rs
// ============================================================================

/**
 * Start a new Claude session for a workspace.
 * Tauri command: claude_start_session
 */
export async function claudeStartSession(
  workspaceId: string,
  cwd: string,
  options?: { model?: string; permissionMode?: string },
) {
  return invoke<{ result?: { sessionId: string } }>("claude_start_session", {
    workspaceId,
    cwd,
    model: options?.model ?? null,
    permissionMode: options?.permissionMode ?? null,
  });
}

/**
 * Resume an existing Claude session.
 * Tauri command: claude_resume_session
 */
export async function claudeResumeSession(
  workspaceId: string,
  sessionId: string,
) {
  return invoke<unknown>("claude_resume_session", {
    workspaceId,
    sessionId,
  });
}

/**
 * Send a message to a Claude session.
 * Tauri command: claude_send_message
 */
export async function claudeSendMessage(
  sessionId: string,
  workspaceId: string,
  message: string,
  images?: string[],
  messageId?: string,
) {
  return invoke("claude_send_message", {
    sessionId,
    workspaceId,
    message,
    images: images ?? null,
    messageId: messageId ?? null,
  });
}

/**
 * Interrupt an active Claude session.
 * Tauri command: claude_interrupt
 */
export async function claudeInterrupt(sessionId: string) {
  return invoke("claude_interrupt", { sessionId });
}

/**
 * Respond to a Claude permission request.
 * Tauri command: claude_respond_permission
 */
export async function claudeRespondPermission(
  sessionId: string,
  toolUseId: string,
  decision: "allow" | "deny",
  message?: string,
) {
  return invoke("claude_respond_permission", {
    sessionId,
    toolUseId,
    decision,
    message: message ?? null,
  });
}

/**
 * Close a Claude session.
 * Tauri command: claude_close_session
 */
export async function claudeCloseSession(sessionId: string) {
  return invoke("claude_close_session", { sessionId });
}

/**
 * Rewind a Claude session to a specific message, restoring file checkpoints.
 * Tauri command: claude_rewind_files
 * Note: Requires file checkpointing to be enabled in the bridge.
 */
export async function claudeRewindToMessage(
  sessionId: string,
  messageId: string,
): Promise<{
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}> {
  return invoke("claude_rewind_files", { sessionId, userMessageId: messageId });
}

/**
 * List available Claude models.
 * Tauri command: claude_list_models
 */
export async function claudeListModels(sessionId?: string) {
  return invoke<{ result?: { models: unknown[] } }>("claude_list_models", {
    sessionId: sessionId ?? null,
  });
}

/**
 * Run Claude Code doctor to validate the installation.
 * Tauri command: claude_doctor
 */
export async function runClaudeDoctor(
  claudeCodeBin: string | null,
): Promise<ClaudeDoctorResult> {
  return invoke<ClaudeDoctorResult>("claude_doctor", {
    claudeCodeBin,
  });
}

// Legacy aliases for compatibility during transition
export const createSession = claudeStartSession;
export const resumeSession = claudeResumeSession;
export const sendMessage = claudeSendMessage;
export const interruptSession = claudeInterrupt;
export const respondToPermission = claudeRespondPermission;

// ============================================================================
// Registry Service Functions (Agent C)
// ============================================================================

/**
 * Get visible sessions for a workspace from the registry.
 */
export async function getVisibleSessions(
  workspaceId: string,
): Promise<SessionEntry[]> {
  return invoke<SessionEntry[]>("get_visible_sessions", { workspaceId });
}

/**
 * Scan for available sessions to import from Claude projects.
 */
export async function scanAvailableSessions(
  workspaceId: string,
): Promise<SessionEntry[]> {
  return invoke<SessionEntry[]>("scan_available_sessions", { workspaceId });
}

/**
 * Import sessions into the visibility list.
 */
export async function importSessions(
  workspaceId: string,
  sessionIds: string[],
  sessionsData: SessionEntry[],
): Promise<void> {
  return invoke("import_sessions", { workspaceId, sessionIds, sessionsData });
}

/**
 * Archive a session (remove from visibility, keep on disk).
 */
export async function registryArchiveSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  return invoke("registry_archive_session", { workspaceId, sessionId });
}

/**
 * Register a new session (called when bridge creates one).
 */
export async function registerSession(
  workspaceId: string,
  session: SessionEntry,
): Promise<void> {
  return invoke("register_session", { workspaceId, session });
}

/**
 * Update session activity timestamp and preview.
 */
export async function updateSessionActivity(
  sessionId: string,
  preview?: string,
): Promise<void> {
  return invoke("update_session_activity", { sessionId, preview: preview ?? null });
}

export async function getSessionHistory(sessionId: string): Promise<{
  items: ConversationItem[];
  preview: string | null;
  lastActivity: number;
}> {
  return invoke("get_session_history", { sessionId });
}

/**
 * Get archived (hidden) sessions for a workspace.
 */
export async function getArchivedSessions(
  workspaceId: string,
): Promise<SessionEntry[]> {
  return invoke<SessionEntry[]>("get_archived_sessions", { workspaceId });
}

/**
 * Unarchive a session (add back to visibility list).
 */
export async function registryUnarchiveSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  return invoke("registry_unarchive_session", { workspaceId, sessionId });
}
