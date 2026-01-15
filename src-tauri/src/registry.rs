use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::types::{SessionEntry, SessionStatus, ThreadRegistry, WorkspaceRegistry};

#[derive(Debug, Serialize)]
pub(crate) struct SessionHistory {
    items: Vec<serde_json::Value>,
    preview: Option<String>,
    #[serde(rename = "lastActivity")]
    last_activity: u64,
}

fn extract_text_from_message(message: &serde_json::Value) -> String {
    if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
        let mut parts = Vec::new();
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
        }
        return parts.join("\n");
    }
    if let Some(text) = message.get("text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    String::new()
}

fn parse_session_history(
    session_id: &str,
    transcript_path: &Path,
) -> Result<SessionHistory, String> {
    let file = std::fs::File::open(transcript_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut items = Vec::new();
    let mut preview: Option<String> = None;

    for (index, line) in reader.lines().enumerate() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        let entry: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let entry_type = entry.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if entry_type != "user" && entry_type != "assistant" {
            continue;
        }
        let message = entry.get("message").unwrap_or(&entry);
        let text = extract_text_from_message(message);
        if text.is_empty() {
            continue;
        }
        if preview.is_none() && entry_type == "user" {
            preview = Some(text.clone());
        }
        let role = if entry_type == "assistant" {
            "assistant"
        } else {
            "user"
        };
        let message_id = entry
            .get("uuid")
            .and_then(|u| u.as_str())
            .map(|u| u.to_string())
            .unwrap_or_else(|| format!("{}:{}", session_id, index));
        items.push(serde_json::json!({
            "id": message_id,
            "kind": "message",
            "role": role,
            "text": text,
        }));
    }

    if preview.is_none() {
        preview = items
            .iter()
            .find_map(|item| item.get("text").and_then(|t| t.as_str()).map(|t| t.to_string()));
    }

    let metadata = std::fs::metadata(transcript_path).map_err(|e| e.to_string())?;
    let last_activity = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(SessionHistory {
        items,
        preview,
        last_activity,
    })
}

/// Read registry from threads.json
pub(crate) fn read_registry(path: &PathBuf) -> Result<ThreadRegistry, String> {
    if !path.exists() {
        return Ok(ThreadRegistry::default());
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// Write registry to threads.json (atomic via temp file + rename)
pub(crate) fn write_registry(path: &PathBuf, registry: &ThreadRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;

    // Atomic write: write to temp file, then rename
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&temp_path, path).map_err(|e| e.to_string())
}

/// Convert a workspace cwd path to Claude's project directory name.
/// Claude uses a format like: /Users/foo/bar -> -Users-foo-bar
fn cwd_to_project_dir_name(cwd: &str) -> String {
    // Replace path separators with dashes and prepend with dash
    let normalized = cwd.replace('/', "-").replace('\\', "-");
    // Handle the case where path starts with / (most Unix paths)
    if normalized.starts_with('-') {
        normalized
    } else {
        format!("-{}", normalized)
    }
}

/// Get the Claude projects base directory
fn get_claude_projects_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.join(".claude").join("projects"))
}

/// Derive Claude project/transcript paths from cwd + session_id.
pub(crate) fn derive_project_paths(
    cwd: &str,
    session_id: &str,
) -> Option<(String, String)> {
    let project_dir_name = cwd_to_project_dir_name(cwd);
    let claude_projects = get_claude_projects_dir().ok()?;
    let project_path = claude_projects.join(&project_dir_name);
    let transcript_path = project_path.join(format!("{session_id}.jsonl"));
    Some((
        project_path.to_string_lossy().to_string(),
        transcript_path.to_string_lossy().to_string(),
    ))
}

/// Scan Claude projects directory for sessions matching a workspace cwd.
/// Returns sessions from the project directory that matches the cwd.
pub(crate) fn scan_project_sessions(cwd: &str) -> Result<Vec<SessionEntry>, String> {
    let claude_projects = get_claude_projects_dir()?;

    if !claude_projects.exists() {
        return Ok(Vec::new());
    }

    // Convert cwd to Claude project directory name
    let project_dir_name = cwd_to_project_dir_name(cwd);
    let project_dir = claude_projects.join(&project_dir_name);

    if !project_dir.exists() || !project_dir.is_dir() {
        // No project directory for this cwd
        return Ok(Vec::new());
    }

    scan_project_dir(&project_dir, cwd)
}

/// Scan a single project directory for .jsonl session files.
/// Claude stores sessions as {uuid}.jsonl files.
fn scan_project_dir(project_dir: &Path, cwd: &str) -> Result<Vec<SessionEntry>, String> {
    let mut sessions = Vec::new();

    let entries = std::fs::read_dir(project_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Look for .jsonl files (session transcripts)
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "jsonl" {
                    // Extract session ID from filename (UUID)
                    if let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) {
                        // Parse the JSONL to extract session info
                        if let Ok(session) =
                            extract_session_from_jsonl(&path, session_id, cwd, project_dir)
                        {
                            sessions.push(session);
                        }
                    }
                }
            }
        }
    }

    // Sort by last activity (most recent first)
    sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    Ok(sessions)
}

/// Extract session metadata from a JSONL transcript file.
/// Claude's JSONL format: each line is a JSON object with type, sessionId, cwd, message, etc.
fn extract_session_from_jsonl(
    jsonl_path: &Path,
    session_id: &str,
    expected_cwd: &str,
    project_dir: &Path,
) -> Result<SessionEntry, String> {
    let file = std::fs::File::open(jsonl_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let metadata = std::fs::metadata(jsonl_path).map_err(|e| e.to_string())?;

    let created_at = metadata
        .created()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let last_activity = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut preview: Option<String> = None;
    let mut actual_cwd: Option<String> = None;

    // Parse JSONL lines to find session info
    for line in reader.lines().take(50) {
        // Only scan first 50 lines
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        if line.is_empty() {
            continue;
        }

        let entry: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Extract cwd from any entry that has it
        if actual_cwd.is_none() {
            if let Some(cwd_val) = entry.get("cwd").and_then(|c| c.as_str()) {
                actual_cwd = Some(cwd_val.to_string());
            }
        }

        // Extract preview from first user message
        if preview.is_none() {
            if entry.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(message) = entry.get("message") {
                    // Try to get text from message.content array
                    if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                        for item in content {
                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                    let truncated: String = text.chars().take(100).collect();
                                    preview = Some(if text.len() > 100 {
                                        format!("{}...", truncated)
                                    } else {
                                        truncated
                                    });
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Stop early if we have both
        if preview.is_some() && actual_cwd.is_some() {
            break;
        }
    }

    // Verify the session's cwd matches the expected cwd
    if let Some(ref session_cwd) = actual_cwd {
        // Normalize paths for comparison (remove trailing slashes)
        let normalized_expected = expected_cwd.trim_end_matches('/');
        let normalized_actual = session_cwd.trim_end_matches('/');
        if normalized_expected != normalized_actual {
            return Err(format!(
                "Session cwd mismatch: expected {}, got {}",
                expected_cwd, session_cwd
            ));
        }
    }

    Ok(SessionEntry {
        session_id: session_id.to_string(),
        cwd: actual_cwd.unwrap_or_else(|| expected_cwd.to_string()),
        preview,
        created_at,
        last_activity,
        transcript_path: Some(jsonl_path.to_string_lossy().to_string()),
        project_path: Some(project_dir.to_string_lossy().to_string()),
        status: SessionStatus::Active,
    })
}

/// Get current timestamp in milliseconds
pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================================
// Internal API for Bridge Integration
// ============================================================================

/// Create a new SessionEntry from bridge session/started event data.
/// This is called internally when the Claude bridge creates a new session.
pub(crate) fn create_session_entry(
    session_id: String,
    cwd: String,
    preview: Option<String>,
) -> SessionEntry {
    let now = now_millis();

    // Compute paths from cwd
    let project_dir_name = cwd_to_project_dir_name(&cwd);
    let claude_projects = get_claude_projects_dir().ok();
    let project_path = claude_projects.map(|p| p.join(&project_dir_name).to_string_lossy().to_string());
    let transcript_path = project_path
        .as_ref()
        .map(|p| format!("{}/{}.jsonl", p, session_id));

    SessionEntry {
        session_id,
        cwd,
        preview,
        created_at: now,
        last_activity: now,
        transcript_path,
        project_path,
        status: SessionStatus::Active,
    }
}

/// Register a session directly (for internal use by bridge).
/// This bypasses the Tauri command interface for efficiency.
pub(crate) async fn register_session_internal(
    registry: &mut ThreadRegistry,
    registry_path: &PathBuf,
    workspace_id: &str,
    session: SessionEntry,
) -> Result<(), String> {
    let session_id = session.session_id.clone();

    // Add to sessions
    registry.sessions.insert(session_id.clone(), session);

    // Add to workspace visibility
    let workspace_reg = registry
        .workspaces
        .entry(workspace_id.to_string())
        .or_insert_with(WorkspaceRegistry::default);

    if !workspace_reg.visible_session_ids.contains(&session_id) {
        workspace_reg.visible_session_ids.push(session_id);
    }

    // Persist
    write_registry(registry_path, registry)
}

/// Update session activity directly (for internal use by bridge).
pub(crate) async fn update_session_activity_internal(
    registry: &mut ThreadRegistry,
    registry_path: &PathBuf,
    session_id: &str,
    preview: Option<String>,
) -> Result<(), String> {
    if let Some(session) = registry.sessions.get_mut(session_id) {
        session.last_activity = now_millis();
        if let Some(p) = preview {
            session.preview = Some(p);
        }
    }

    // Persist
    write_registry(registry_path, registry)
}

/// Mark a session as missing (transcript not found).
pub(crate) async fn mark_session_missing(
    registry: &mut ThreadRegistry,
    registry_path: &PathBuf,
    session_id: &str,
) -> Result<(), String> {
    if let Some(session) = registry.sessions.get_mut(session_id) {
        session.status = SessionStatus::Missing;
    }

    write_registry(registry_path, registry)
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get visible sessions for a workspace
#[tauri::command]
pub(crate) async fn get_visible_sessions(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionEntry>, String> {
    let mut registry = state.registry.lock().await;
    let workspaces = state.workspaces.lock().await;

    // Verify workspace exists
    let _workspace = workspaces
        .get(&workspace_id)
        .ok_or_else(|| format!("Workspace {} not found", workspace_id))?;

    let workspace_registry = registry.workspaces.get(&workspace_id);
    let visible_ids: Vec<String> = workspace_registry
        .map(|w| w.visible_session_ids.clone())
        .unwrap_or_default();

    // Check each session's transcript exists and mark missing if not
    let mut needs_persist = false;
    for session_id in &visible_ids {
        if let Some(session) = registry.sessions.get_mut(session_id) {
            if session.status == SessionStatus::Active {
                if let Some(ref path) = session.transcript_path {
                    if !std::path::Path::new(path).exists() {
                        session.status = SessionStatus::Missing;
                        needs_persist = true;
                    }
                }
            }
        }
    }

    // Persist if any sessions were marked missing
    if needs_persist {
        drop(workspaces); // Release lock before writing
        write_registry(&state.registry_path, &registry)?;
    }

    // Collect and return sessions
    let sessions: Vec<SessionEntry> = visible_ids
        .iter()
        .filter_map(|id| registry.sessions.get(id).cloned())
        .collect();

    Ok(sessions)
}

/// Scan for importable sessions from Claude projects
#[tauri::command]
pub(crate) async fn scan_available_sessions(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionEntry>, String> {
    let workspaces = state.workspaces.lock().await;
    let workspace = workspaces
        .get(&workspace_id)
        .ok_or_else(|| format!("Workspace {} not found", workspace_id))?;

    scan_project_sessions(&workspace.path)
}

/// Import sessions into visibility list
#[tauri::command]
pub(crate) async fn import_sessions(
    workspace_id: String,
    session_ids: Vec<String>,
    sessions_data: Vec<SessionEntry>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state.registry.lock().await;

    // Add sessions to the sessions map
    for session in sessions_data {
        registry.sessions.insert(session.session_id.clone(), session);
    }

    // Add to workspace visibility
    let workspace_reg = registry
        .workspaces
        .entry(workspace_id)
        .or_insert_with(WorkspaceRegistry::default);

    for id in session_ids {
        if !workspace_reg.visible_session_ids.contains(&id) {
            workspace_reg.visible_session_ids.push(id);
        }
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

/// Archive a session (remove from visibility, keep in sessions)
#[tauri::command]
pub(crate) async fn registry_archive_session(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state.registry.lock().await;

    if let Some(workspace_reg) = registry.workspaces.get_mut(&workspace_id) {
        workspace_reg
            .visible_session_ids
            .retain(|id| id != &session_id);
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

/// Register a new session (called when Claude bridge creates one)
#[tauri::command]
pub(crate) async fn register_session(
    workspace_id: String,
    session: SessionEntry,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state.registry.lock().await;

    let session_id = session.session_id.clone();

    // Add to sessions
    registry.sessions.insert(session_id.clone(), session);

    // Add to workspace visibility
    let workspace_reg = registry
        .workspaces
        .entry(workspace_id)
        .or_insert_with(WorkspaceRegistry::default);

    if !workspace_reg.visible_session_ids.contains(&session_id) {
        workspace_reg.visible_session_ids.push(session_id);
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

/// Update session activity timestamp and preview
#[tauri::command]
pub(crate) async fn update_session_activity(
    session_id: String,
    preview: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state.registry.lock().await;

    if let Some(session) = registry.sessions.get_mut(&session_id) {
        session.last_activity = now_millis();
        if let Some(p) = preview {
            session.preview = Some(p);
        }
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

/// Load session history from Claude transcript JSONL.
#[tauri::command]
pub(crate) async fn get_session_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<SessionHistory, String> {
    let mut registry = state.registry.lock().await;
    let session = registry
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let mut transcript_path = session.transcript_path.clone();
    if transcript_path.is_none() {
        if let Some((derived_project, derived_transcript)) =
            derive_project_paths(&session.cwd, &session_id)
        {
            transcript_path = Some(derived_transcript);
            if let Some(session) = registry.sessions.get_mut(&session_id) {
                session.transcript_path = transcript_path.clone();
                session.project_path = Some(derived_project);
            }
            let _ = write_registry(&state.registry_path, &registry);
        }
    }
    let transcript_path = transcript_path
        .ok_or_else(|| format!("Session {} has no transcript path", session_id))?;

    // Check if transcript file exists
    let path = Path::new(&transcript_path);
    if !path.exists() {
        // Mark session as missing
        if let Some(s) = registry.sessions.get_mut(&session_id) {
            if s.status != SessionStatus::Missing {
                s.status = SessionStatus::Missing;
                let _ = write_registry(&state.registry_path, &registry);
            }
        }
        return Err(format!("Transcript file not found: {}", transcript_path));
    }

    parse_session_history(&session_id, path)
}

/// Get archived (hidden) sessions for a workspace.
/// These are sessions in the sessions map but NOT in visible_session_ids.
#[tauri::command]
pub(crate) async fn get_archived_sessions(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionEntry>, String> {
    let registry = state.registry.lock().await;

    let workspace_registry = registry.workspaces.get(&workspace_id);
    let visible_ids: std::collections::HashSet<&String> = workspace_registry
        .map(|w| w.visible_session_ids.iter().collect())
        .unwrap_or_default();

    // Find sessions that belong to this workspace but are not visible
    // We need to match by cwd since sessions store their workspace cwd
    let workspaces = state.workspaces.lock().await;
    let workspace = workspaces.get(&workspace_id);
    let workspace_cwd = workspace.map(|w| w.path.as_str());

    let archived: Vec<SessionEntry> = registry
        .sessions
        .values()
        .filter(|session| {
            // Session belongs to this workspace (by cwd) and is not visible
            workspace_cwd.map_or(false, |cwd| session.cwd == cwd)
                && !visible_ids.contains(&session.session_id)
        })
        .cloned()
        .collect();

    Ok(archived)
}

/// Unarchive a session (add back to visibility list).
#[tauri::command]
pub(crate) async fn registry_unarchive_session(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state.registry.lock().await;

    // Verify session exists
    if !registry.sessions.contains_key(&session_id) {
        return Err(format!("Session {} not found", session_id));
    }

    // Add to workspace visibility
    let workspace_reg = registry
        .workspaces
        .entry(workspace_id)
        .or_insert_with(WorkspaceRegistry::default);

    if !workspace_reg.visible_session_ids.contains(&session_id) {
        workspace_reg.visible_session_ids.push(session_id);
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cwd_to_project_dir_name() {
        // Unix-style absolute paths
        assert_eq!(
            cwd_to_project_dir_name("/Users/thomasmorton/CodexMonitor"),
            "-Users-thomasmorton-CodexMonitor"
        );
        assert_eq!(
            cwd_to_project_dir_name("/home/user/project"),
            "-home-user-project"
        );

        // Path without leading slash
        assert_eq!(
            cwd_to_project_dir_name("Users/foo/bar"),
            "-Users-foo-bar"
        );

        // Windows-style paths (backslashes)
        assert_eq!(
            cwd_to_project_dir_name("C:\\Users\\foo\\bar"),
            "-C:-Users-foo-bar"
        );

        // Single directory
        assert_eq!(cwd_to_project_dir_name("/project"), "-project");
    }

    #[test]
    fn test_create_session_entry() {
        let session = create_session_entry(
            "test-uuid-123".to_string(),
            "/Users/test/project".to_string(),
            Some("Hello world".to_string()),
        );

        assert_eq!(session.session_id, "test-uuid-123");
        assert_eq!(session.cwd, "/Users/test/project");
        assert_eq!(session.preview, Some("Hello world".to_string()));
        assert_eq!(session.status, SessionStatus::Active);
        assert!(session.created_at > 0);
        assert!(session.last_activity > 0);
    }

    #[test]
    fn test_registry_serialization() {
        let mut registry = ThreadRegistry::default();

        let session = SessionEntry {
            session_id: "session-1".to_string(),
            cwd: "/test/path".to_string(),
            preview: Some("Test preview".to_string()),
            created_at: 1700000000000,
            last_activity: 1700000001000,
            transcript_path: Some("/path/to/transcript.jsonl".to_string()),
            project_path: Some("/path/to/project".to_string()),
            status: SessionStatus::Active,
        };

        registry.sessions.insert("session-1".to_string(), session);

        let mut workspace_reg = WorkspaceRegistry::default();
        workspace_reg.visible_session_ids.push("session-1".to_string());
        registry.workspaces.insert("workspace-1".to_string(), workspace_reg);

        // Serialize and deserialize
        let json = serde_json::to_string(&registry).expect("serialize");
        let parsed: ThreadRegistry = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.workspaces.len(), 1);

        let session = parsed.sessions.get("session-1").unwrap();
        assert_eq!(session.preview, Some("Test preview".to_string()));
    }
}
