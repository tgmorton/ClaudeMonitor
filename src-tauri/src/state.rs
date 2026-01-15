use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::claude::{ClaudeBridge, ClaudeSessionInfo};
use crate::registry::read_registry;
use crate::storage::{read_settings, read_workspaces};
use crate::types::{AppSettings, ThreadRegistry, WorkspaceEntry};

pub(crate) struct AppState {
    pub(crate) workspaces: Mutex<HashMap<String, WorkspaceEntry>>,
    pub(crate) sessions: Mutex<HashMap<String, Arc<crate::codex::WorkspaceSession>>>,
    /// Global Claude bridge process (single instance for all workspaces)
    pub(crate) claude_bridge: Mutex<Option<Arc<ClaudeBridge>>>,
    /// Map of session_id -> ClaudeSessionInfo for tracking active Claude sessions
    pub(crate) claude_sessions: Mutex<HashMap<String, ClaudeSessionInfo>>,
    pub(crate) storage_path: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) registry_path: PathBuf,
    pub(crate) app_settings: Mutex<AppSettings>,
    pub(crate) registry: Mutex<ThreadRegistry>,
}

impl AppState {
    pub(crate) fn load(app: &AppHandle) -> Self {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| ".".into()));
        let storage_path = data_dir.join("workspaces.json");
        let settings_path = data_dir.join("settings.json");
        let registry_path = data_dir.join("threads.json");
        let workspaces = read_workspaces(&storage_path).unwrap_or_default();
        let app_settings = read_settings(&settings_path).unwrap_or_default();
        let registry = read_registry(&registry_path).unwrap_or_default();
        Self {
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(HashMap::new()),
            claude_bridge: Mutex::new(None),
            claude_sessions: Mutex::new(HashMap::new()),
            storage_path,
            settings_path,
            registry_path,
            app_settings: Mutex::new(app_settings),
            registry: Mutex::new(registry),
        }
    }
}
