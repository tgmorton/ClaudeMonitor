use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitFileStatus {
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) additions: i64,
    pub(crate) deletions: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitFileDiff {
    pub(crate) path: String,
    pub(crate) diff: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitLogEntry {
    pub(crate) sha: String,
    pub(crate) summary: String,
    pub(crate) author: String,
    pub(crate) timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitLogResponse {
    pub(crate) total: usize,
    pub(crate) entries: Vec<GitLogEntry>,
    #[serde(default)]
    pub(crate) ahead: usize,
    #[serde(default)]
    pub(crate) behind: usize,
    #[serde(default, rename = "aheadEntries")]
    pub(crate) ahead_entries: Vec<GitLogEntry>,
    #[serde(default, rename = "behindEntries")]
    pub(crate) behind_entries: Vec<GitLogEntry>,
    #[serde(default)]
    pub(crate) upstream: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitHubIssue {
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) url: String,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitHubIssuesResponse {
    pub(crate) total: usize,
    pub(crate) issues: Vec<GitHubIssue>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct BranchInfo {
    pub(crate) name: String,
    pub(crate) last_commit: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) codex_bin: Option<String>,
    #[serde(default)]
    pub(crate) kind: WorkspaceKind,
    #[serde(default, rename = "parentId")]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) worktree: Option<WorktreeInfo>,
    #[serde(default)]
    pub(crate) settings: WorkspaceSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) connected: bool,
    pub(crate) codex_bin: Option<String>,
    #[serde(default)]
    pub(crate) kind: WorkspaceKind,
    #[serde(default, rename = "parentId")]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) worktree: Option<WorktreeInfo>,
    #[serde(default)]
    pub(crate) settings: WorkspaceSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceKind {
    Main,
    Worktree,
}

impl Default for WorkspaceKind {
    fn default() -> Self {
        WorkspaceKind::Main
    }
}

impl WorkspaceKind {
    pub(crate) fn is_worktree(&self) -> bool {
        matches!(self, WorkspaceKind::Worktree)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorktreeInfo {
    pub(crate) branch: String,
}

/// MCP Server configuration for workspace-level settings
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct McpServerConfig {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub(crate) server_type: Option<String>, // "stdio", "sse", "http"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) headers: Option<HashMap<String, String>>,
}

/// Plugin configuration for workspace-level settings
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct PluginConfig {
    #[serde(rename = "type")]
    pub(crate) plugin_type: String, // "local"
    pub(crate) path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkspaceSettings {
    #[serde(default, rename = "sidebarCollapsed")]
    pub(crate) sidebar_collapsed: bool,
    #[serde(default, rename = "sortOrder")]
    pub(crate) sort_order: Option<u32>,
    #[serde(default, rename = "mcpServers", skip_serializing_if = "Option::is_none")]
    pub(crate) mcp_servers: Option<HashMap<String, McpServerConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plugins: Option<Vec<PluginConfig>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct AppSettings {
    #[serde(default, rename = "codexBin")]
    pub(crate) codex_bin: Option<String>,
    #[serde(default, rename = "claudeCodeBin")]
    pub(crate) claude_code_bin: Option<String>,
    #[serde(default = "default_access_mode", rename = "defaultAccessMode")]
    pub(crate) default_access_mode: String,
    #[serde(
        default = "default_permission_mode",
        rename = "defaultPermissionMode"
    )]
    pub(crate) default_permission_mode: String,
    #[serde(default = "default_ui_scale", rename = "uiScale")]
    pub(crate) ui_scale: f64,
}

fn default_access_mode() -> String {
    "current".to_string()
}

fn default_ui_scale() -> f64 {
    1.0
}

fn default_permission_mode() -> String {
    "default".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_bin: None,
            claude_code_bin: None,
            default_access_mode: "current".to_string(),
            default_permission_mode: "default".to_string(),
            ui_scale: 1.0,
        }
    }
}

// Registry types for Claude session management

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionStatus {
    Active,
    Missing,
}

impl Default for SessionStatus {
    fn default() -> Self {
        SessionStatus::Active
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionEntry {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    #[serde(default)]
    pub(crate) preview: Option<String>,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: u64,
    #[serde(rename = "lastActivity")]
    pub(crate) last_activity: u64,
    #[serde(default, rename = "transcriptPath")]
    pub(crate) transcript_path: Option<String>,
    #[serde(default, rename = "projectPath")]
    pub(crate) project_path: Option<String>,
    #[serde(default)]
    pub(crate) status: SessionStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkspaceRegistry {
    #[serde(default, rename = "projectPath")]
    pub(crate) project_path: Option<String>,
    #[serde(default, rename = "visibleSessionIds")]
    pub(crate) visible_session_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ThreadRegistry {
    #[serde(default = "default_registry_version")]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) workspaces: HashMap<String, WorkspaceRegistry>,
    #[serde(default)]
    pub(crate) sessions: HashMap<String, SessionEntry>,
}

fn default_registry_version() -> u32 {
    1
}

impl Default for ThreadRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            workspaces: HashMap::new(),
            sessions: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, WorkspaceEntry, WorkspaceKind, ThreadRegistry, SessionEntry, SessionStatus};

    #[test]
    fn app_settings_defaults_from_empty_json() {
        let settings: AppSettings = serde_json::from_str("{}").expect("settings deserialize");
        assert!(settings.codex_bin.is_none());
        assert_eq!(settings.default_access_mode, "current");
        assert!((settings.ui_scale - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn workspace_entry_defaults_from_minimal_json() {
        let entry: WorkspaceEntry = serde_json::from_str(
            r#"{"id":"1","name":"Test","path":"/tmp","codexBin":null}"#,
        )
        .expect("workspace deserialize");
        assert!(matches!(entry.kind, WorkspaceKind::Main));
        assert!(entry.parent_id.is_none());
        assert!(entry.worktree.is_none());
        assert!(entry.settings.sort_order.is_none());
    }

    #[test]
    fn thread_registry_defaults_from_empty_json() {
        let registry: ThreadRegistry = serde_json::from_str("{}").expect("registry deserialize");
        assert_eq!(registry.version, 1);
        assert!(registry.workspaces.is_empty());
        assert!(registry.sessions.is_empty());
    }

    #[test]
    fn session_entry_serialization_roundtrip() {
        let session = SessionEntry {
            session_id: "test-123".to_string(),
            cwd: "/home/user/project".to_string(),
            preview: Some("Hello world".to_string()),
            created_at: 1700000000000,
            last_activity: 1700000001000,
            transcript_path: Some("/path/to/transcript.json".to_string()),
            project_path: Some("/path/to/project".to_string()),
            status: SessionStatus::Active,
        };
        let json = serde_json::to_string(&session).expect("serialize");
        let parsed: SessionEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.session_id, "test-123");
        assert_eq!(parsed.status, SessionStatus::Active);
    }
}
