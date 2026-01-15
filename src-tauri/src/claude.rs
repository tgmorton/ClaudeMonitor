use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

use crate::registry::{derive_project_paths, now_millis, write_registry};
use crate::types::{SessionEntry, SessionStatus, WorkspaceRegistry};

/// Event emitted to the frontend from the Claude bridge.
/// Flattened structure for frontend consumption.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEvent {
    /// Event type (e.g., "session/started", "message/delta")
    #[serde(rename = "type")]
    pub event_type: String,
    /// Claude session ID
    pub session_id: String,
    /// Workspace ID
    pub workspace_id: String,
    /// Event timestamp (ms)
    pub timestamp: i64,
    /// Event-specific payload
    pub payload: Value,
}

/// Information about a Claude session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    pub workspace_id: String,
    pub cwd: String,
    pub started_at: u64,
}

/// The Claude bridge process that wraps the Agent SDK.
pub struct ClaudeBridge {
    pub(crate) child: Mutex<Child>,
    pub(crate) stdin: Mutex<ChildStdin>,
    pub(crate) pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    pub(crate) next_id: AtomicU64,
}

impl ClaudeBridge {
    /// Write a JSON message to stdin.
    async fn write_message(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let mut line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())
    }

    /// Send a request and wait for a response.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write_message(json!({ "id": id, "method": method, "params": params }))
            .await?;
        rx.await.map_err(|_| "request canceled".to_string())
    }

    /// Send a notification (no response expected).
    #[allow(dead_code)]
    pub async fn send_notification(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let value = if let Some(params) = params {
            json!({ "method": method, "params": params })
        } else {
            json!({ "method": method })
        };
        self.write_message(value).await
    }

    /// Kill the bridge process.
    pub async fn kill(&self) -> Result<(), String> {
        let mut child = self.child.lock().await;
        child.kill().await.map_err(|e| e.to_string())
    }
}

/// Build the PATH environment for finding Node.js and Claude Code.
fn build_node_path_env(claude_bin: Option<&str>) -> Option<String> {
    let mut paths: Vec<String> = env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect();

    let mut extras = vec![
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<String>>();

    if let Ok(home) = env::var("HOME") {
        extras.push(format!("{home}/.local/bin"));
        extras.push(format!("{home}/.local/share/mise/shims"));
        extras.push(format!("{home}/.cargo/bin"));
        extras.push(format!("{home}/.bun/bin"));

        // Add NVM paths
        let nvm_root = Path::new(&home).join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm_root) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.is_dir() {
                    extras.push(bin_path.to_string_lossy().to_string());
                }
            }
        }
    }

    // Add directory of custom claude bin if provided
    if let Some(bin_path) = claude_bin.filter(|v| !v.trim().is_empty()) {
        if let Some(parent) = Path::new(bin_path).parent() {
            extras.push(parent.to_string_lossy().to_string());
        }
    }

    for extra in extras {
        if !paths.contains(&extra) {
            paths.push(extra);
        }
    }

    if paths.is_empty() {
        None
    } else {
        Some(paths.join(":"))
    }
}

/// Get the path to the bridge script.
fn get_bridge_path(app_handle: &AppHandle) -> Result<String, String> {
    use std::path::PathBuf;
    use std::path::Path;

    fn find_bridge_in_ancestors(start: &Path) -> Option<PathBuf> {
        let mut current = Some(start);
        while let Some(dir) = current {
            let candidate = dir.join("src").join("claude-bridge").join("index.ts");
            if candidate.exists() {
                return Some(candidate);
            }
            current = dir.parent();
        }
        None
    }

    // In development, use the source directory
    // In production, the bridge should be bundled with the app
    let resource_dir: PathBuf = app_handle
        .path()
        .resource_dir()
        .map_err(|e: tauri::Error| e.to_string())?;

    // Try resource directory first (production)
    let resource_bridge = resource_dir.join("claude-bridge").join("index.ts");
    if resource_bridge.exists() {
        return Ok(resource_bridge.to_string_lossy().to_string());
    }

    // Fall back to source directory (development)
    if let Some(src_bridge) = find_bridge_in_ancestors(&resource_dir) {
        return Ok(src_bridge.to_string_lossy().to_string());
    }

    // Try current working directory and its ancestors (worktree/dev)
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(src_bridge) = find_bridge_in_ancestors(&cwd) {
            return Ok(src_bridge.to_string_lossy().to_string());
        }
    }

    // Last resort: relative to current dir
    let local_bridge = Path::new("src/claude-bridge/index.ts");
    if local_bridge.exists() {
        return Ok(local_bridge.to_string_lossy().to_string());
    }

    Err("Could not find claude-bridge/index.ts".to_string())
}

/// Spawn the Claude bridge process.
pub async fn spawn_claude_bridge(
    app_handle: AppHandle,
) -> Result<Arc<ClaudeBridge>, String> {
    let bridge_path = get_bridge_path(&app_handle)?;
    let path_env = build_node_path_env(None);

    // Build tsx command to run TypeScript bridge
    let mut command = Command::new("npx");
    if let Some(ref path) = path_env {
        command.env("PATH", path);
    }
    command.arg("tsx");
    command.arg(&bridge_path);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            "npx not found. Please install Node.js 18+ and ensure it's on your PATH."
                .to_string()
        } else {
            format!("Failed to spawn Claude bridge: {e}")
        }
    })?;

    let stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;

    let bridge = Arc::new(ClaudeBridge {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
    });

    // Spawn stdout reader task
    let bridge_clone = Arc::clone(&bridge);
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }

            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("Claude bridge parse error: {err}, line: {line}");
                    let event = ClaudeEvent {
                        event_type: "error".to_string(),
                        session_id: String::new(),
                        workspace_id: String::new(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                        payload: json!({
                            "code": "PARSE_ERROR",
                            "message": format!("Failed to parse bridge output: {err}"),
                            "recoverable": true
                        }),
                    };
                    let _ = app_handle_clone.emit("claude-event", event);
                    continue;
                }
            };

            // Extract fields from bridge event
            let event_type = value
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();
            let session_id = value
                .get("sessionId")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let workspace_id = value
                .get("workspaceId")
                .and_then(|w| w.as_str())
                .unwrap_or("")
                .to_string();
            let timestamp = value
                .get("timestamp")
                .and_then(|t| t.as_i64())
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            let payload = value
                .get("payload")
                .cloned()
                .unwrap_or(Value::Null);

            // Check if this is a response to a pending request
            if event_type == "response" {
                if let Some(id) = payload.get("id").and_then(|id| id.as_u64()) {
                    if let Some(tx) = bridge_clone.pending.lock().await.remove(&id) {
                        let response = if let Some(error) = payload.get("error") {
                            json!({ "error": error })
                        } else if let Some(result) = payload.get("result") {
                            json!({ "result": result })
                        } else {
                            json!({ "result": null })
                        };
                        let _ = tx.send(response);
                        continue;
                    }
                }
            }

            // Emit flattened event to frontend
            let event = ClaudeEvent {
                event_type: event_type.clone(),
                session_id: session_id.clone(),
                workspace_id: workspace_id.clone(),
                timestamp,
                payload: payload.clone(),
            };
            let _ = app_handle_clone.emit("claude-event", event);

            // Handle registry updates for session lifecycle events
            if event_type == "session/started" {
                if !session_id.is_empty() && !workspace_id.is_empty() {
                    let state: tauri::State<'_, crate::state::AppState> =
                        app_handle_clone.state();
                    let info = ClaudeSessionInfo {
                        session_id: session_id.clone(),
                        workspace_id: workspace_id.clone(),
                        cwd: payload
                            .get("cwd")
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .to_string(),
                        started_at: chrono::Utc::now().timestamp_millis() as u64,
                    };
                    state
                        .claude_sessions
                        .lock()
                        .await
                        .insert(session_id.clone(), info);
                }
                // Register the new session
                if let Err(e) = handle_session_started_registry(
                    &app_handle_clone,
                    &session_id,
                    &workspace_id,
                    &payload,
                )
                .await
                {
                    eprintln!("Failed to register session: {e}");
                }
            } else if event_type == "result" {
                // Update session activity on completion
                if let Err(e) =
                    handle_session_activity_update(&app_handle_clone, &session_id, &payload).await
                {
                    eprintln!("Failed to update session activity: {e}");
                }
            }
        }
        eprintln!("Claude bridge stdout reader exited");
    });

    // Spawn stderr reader task (for logging)
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            // Log to console and optionally emit as event
            eprintln!("Claude bridge stderr: {line}");
            let event = ClaudeEvent {
                event_type: "bridge/stderr".to_string(),
                session_id: String::new(),
                workspace_id: String::new(),
                timestamp: chrono::Utc::now().timestamp_millis(),
                payload: json!({ "message": line }),
            };
            let _ = app_handle_clone.emit("claude-event", event);
        }
    });

    // Initialize the bridge
    let init_params = json!({
        "clientInfo": {
            "name": "codex_monitor",
            "version": env!("CARGO_PKG_VERSION")
        }
    });

    let init_result = timeout(
        Duration::from_secs(30),
        bridge.send_request("initialize", init_params),
    )
    .await;

    match init_result {
        Ok(Ok(response)) => {
            if response.get("error").is_some() {
                let _ = bridge.kill().await;
                return Err(format!(
                    "Claude bridge initialization failed: {:?}",
                    response.get("error")
                ));
            }
            // Emit connected event
            let event = ClaudeEvent {
                event_type: "bridge/connected".to_string(),
                session_id: String::new(),
                workspace_id: String::new(),
                timestamp: chrono::Utc::now().timestamp_millis(),
                payload: response.get("result").cloned().unwrap_or(Value::Null),
            };
            let _ = app_handle.emit("claude-event", event);
        }
        Ok(Err(e)) => {
            let _ = bridge.kill().await;
            return Err(format!("Claude bridge initialization failed: {e}"));
        }
        Err(_) => {
            let _ = bridge.kill().await;
            return Err(
                "Claude bridge did not respond to initialize within 30 seconds.".to_string(),
            );
        }
    }

    Ok(bridge)
}

// ============================================================================
// Registry Integration Helpers
// ============================================================================

/// Handle session/started event by registering the session in the registry.
async fn handle_session_started_registry(
    app_handle: &AppHandle,
    session_id: &str,
    workspace_id: &str,
    payload: &Value,
) -> Result<(), String> {
    use tauri::Manager;

    let state: tauri::State<'_, crate::state::AppState> = app_handle.state();

    let cwd = payload
        .get("cwd")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let mut transcript_path = payload
        .get("transcriptPath")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let mut project_path = payload
        .get("projectPath")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());
    if transcript_path.is_none() {
        if let Some((derived_project, derived_transcript)) =
            derive_project_paths(&cwd, session_id)
        {
            transcript_path = Some(derived_transcript);
            if project_path.is_none() {
                project_path = Some(derived_project);
            }
        }
    }

    let session = SessionEntry {
        session_id: session_id.to_string(),
        cwd,
        preview: None,
        created_at: now_millis(),
        last_activity: now_millis(),
        transcript_path,
        project_path,
        status: SessionStatus::Active,
    };

    // Add to registry
    let mut registry = state.registry.lock().await;
    registry
        .sessions
        .insert(session_id.to_string(), session);

    // Add to workspace visibility
    let workspace_reg = registry
        .workspaces
        .entry(workspace_id.to_string())
        .or_insert_with(WorkspaceRegistry::default);

    if !workspace_reg.visible_session_ids.contains(&session_id.to_string()) {
        workspace_reg.visible_session_ids.push(session_id.to_string());
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

/// Handle result event by updating session activity timestamp.
async fn handle_session_activity_update(
    app_handle: &AppHandle,
    session_id: &str,
    _payload: &Value,
) -> Result<(), String> {
    use tauri::Manager;

    let state: tauri::State<'_, crate::state::AppState> = app_handle.state();
    let mut registry = state.registry.lock().await;

    if let Some(session) = registry.sessions.get_mut(session_id) {
        session.last_activity = now_millis();
    }

    // Persist
    write_registry(&state.registry_path, &registry)?;

    Ok(())
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Check if Claude Code / Node.js is properly installed.
#[tauri::command]
pub async fn claude_doctor(
    claude_code_bin: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    // Get default bin from settings if not provided
    let default_bin = {
        let settings = state.app_settings.lock().await;
        settings.claude_code_bin.clone()
    };
    let resolved_bin = claude_code_bin
        .filter(|v| !v.trim().is_empty())
        .or(default_bin);

    check_claude_installation(resolved_bin.as_deref()).await
}

/// Start a new Claude session for a workspace.
#[tauri::command]
pub async fn claude_start_session(
    workspace_id: String,
    cwd: String,
    model: Option<String>,
    permission_mode: Option<String>,
    // Phase 3: File checkpointing
    enable_file_checkpointing: Option<bool>,
    // Phase 4: Extensibility options
    mcp_servers: Option<Value>,
    plugins: Option<Value>,
    agents: Option<Value>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    // Ensure bridge is running
    let bridge = ensure_bridge_running(&app_handle, &state).await?;

    let (default_permission_mode, claude_code_bin) = {
        let settings = state.app_settings.lock().await;
        (
            settings.default_permission_mode.clone(),
            settings.claude_code_bin.clone(),
        )
    };

    let params = json!({
        "workspaceId": workspace_id,
        "cwd": cwd,
        "model": model,
        "permissionMode": permission_mode.unwrap_or(default_permission_mode),
        "claudeCodeBin": claude_code_bin,
        "enableFileCheckpointing": enable_file_checkpointing,
        "mcpServers": mcp_servers,
        "plugins": plugins,
        "agents": agents,
    });

    let response = bridge.send_request("session/start", params).await?;

    Ok(response)
}

/// Resume an existing Claude session.
#[tauri::command]
pub async fn claude_resume_session(
    workspace_id: String,
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;

    let cwd = {
        let workspaces = state.workspaces.lock().await;
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or_else(|| format!("Workspace {} not found", workspace_id))?;
        workspace.path.clone()
    };
    let claude_code_bin = {
        let settings = state.app_settings.lock().await;
        settings.claude_code_bin.clone()
    };

    let params = json!({
        "workspaceId": workspace_id,
        "sessionId": session_id,
        "cwd": cwd,
        "claudeCodeBin": claude_code_bin,
    });

    bridge.send_request("session/resume", params).await
}

/// Send a message to a Claude session.
#[tauri::command]
pub async fn claude_send_message(
    session_id: String,
    workspace_id: String,
    message: String,
    images: Option<Vec<String>>,
    message_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;

    let params = json!({
        "sessionId": session_id,
        "workspaceId": workspace_id,
        "message": message,
        "images": images,
        "messageId": message_id,
    });

    bridge.send_request("message/send", params).await
}

/// Interrupt the current processing in a Claude session.
#[tauri::command]
pub async fn claude_interrupt(
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;

    let params = json!({
        "sessionId": session_id,
    });

    bridge.send_request("message/interrupt", params).await
}

/// Respond to a permission request.
#[tauri::command]
pub async fn claude_respond_permission(
    session_id: String,
    tool_use_id: String,
    decision: String,
    message: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;

    let params = json!({
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "decision": decision,
        "message": message,
    });

    bridge.send_request("permission/respond", params).await
}

/// Get list of available models (requires active session).
#[tauri::command]
pub async fn claude_list_models(
    session_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;
    let resolved_session_id = match session_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => Some(id),
        None => {
            let sessions = state.claude_sessions.lock().await;
            sessions.keys().next().cloned()
        }
    };
    let session_id = resolved_session_id.ok_or_else(|| "No active Claude session found".to_string())?;
    let params = json!({
        "sessionId": session_id,
    });
    bridge.send_request("model/list", params).await
}

/// Get list of available slash commands (skills).
#[tauri::command]
pub async fn claude_list_commands(
    session_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;
    let params = json!({
        "sessionId": session_id,
    });
    bridge.send_request("command/list", params).await
}

/// Get MCP server status for a session.
#[tauri::command]
pub async fn claude_mcp_status(
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;
    let params = json!({
        "sessionId": session_id,
    });
    bridge.send_request("mcp/status", params).await
}

/// Rewind files to a previous state (Phase 3).
/// Requires enableFileCheckpointing to have been set on session start.
#[tauri::command]
pub async fn claude_rewind_files(
    session_id: String,
    user_message_id: String,
    dry_run: Option<bool>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;
    let params = json!({
        "sessionId": session_id,
        "userMessageId": user_message_id,
        "dryRun": dry_run,
    });
    bridge.send_request("session/rewind", params).await
}

/// Dynamically update MCP servers for a session (Phase 4).
#[tauri::command]
pub async fn claude_set_mcp_servers(
    session_id: String,
    servers: Value,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;
    let params = json!({
        "sessionId": session_id,
        "servers": servers,
    });
    bridge.send_request("mcp/set", params).await
}

/// Close a Claude session.
#[tauri::command]
pub async fn claude_close_session(
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Value, String> {
    let bridge = ensure_bridge_running(&app_handle, &state).await?;

    let params = json!({
        "sessionId": session_id,
    });

    let result = bridge.send_request("session/close", params).await;

    // Remove from tracked sessions
    state.claude_sessions.lock().await.remove(&session_id);

    result
}

/// Ensure the Claude bridge is running, starting it if necessary.
async fn ensure_bridge_running(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, crate::state::AppState>,
) -> Result<Arc<ClaudeBridge>, String> {
    let mut bridge_guard = state.claude_bridge.lock().await;

    if let Some(ref bridge) = *bridge_guard {
        return Ok(Arc::clone(bridge));
    }

    // Start the bridge
    let bridge = spawn_claude_bridge(app_handle.clone()).await?;
    *bridge_guard = Some(Arc::clone(&bridge));

    Ok(bridge)
}

// ============================================================================
// Internal Functions
// ============================================================================

/// Check if Claude Code / Node.js is properly installed.
async fn check_claude_installation(claude_bin: Option<&str>) -> Result<Value, String> {
    let path_env = build_node_path_env(claude_bin);

    // Check Node.js
    let mut node_command = Command::new("node");
    if let Some(ref path) = path_env {
        node_command.env("PATH", path);
    }
    node_command.arg("--version");
    node_command.stdout(std::process::Stdio::piped());
    node_command.stderr(std::process::Stdio::piped());

    let (node_ok, node_version, node_details) =
        match timeout(Duration::from_secs(5), node_command.output()).await {
            Ok(result) => match result {
                Ok(output) => {
                    if output.status.success() {
                        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        (
                            !version.is_empty(),
                            if version.is_empty() {
                                None
                            } else {
                                Some(version)
                            },
                            None,
                        )
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        (false, None, Some(stderr.trim().to_string()))
                    }
                }
                Err(err) => {
                    if err.kind() == ErrorKind::NotFound {
                        (false, None, Some("Node.js not found on PATH.".to_string()))
                    } else {
                        (false, None, Some(err.to_string()))
                    }
                }
            },
            Err(_) => (
                false,
                None,
                Some("Timed out while checking Node.js.".to_string()),
            ),
        };

    // Check Claude Code CLI
    let claude_bin_name = claude_bin
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("claude");
    let mut claude_command = Command::new(claude_bin_name);
    if let Some(ref path) = path_env {
        claude_command.env("PATH", path);
    }
    claude_command.arg("--version");
    claude_command.stdout(std::process::Stdio::piped());
    claude_command.stderr(std::process::Stdio::piped());

    let (claude_ok, claude_version, claude_details) =
        match timeout(Duration::from_secs(5), claude_command.output()).await {
            Ok(result) => match result {
                Ok(output) => {
                    if output.status.success() {
                        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        (
                            !version.is_empty(),
                            if version.is_empty() {
                                None
                            } else {
                                Some(version)
                            },
                            None,
                        )
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        (false, None, Some(stderr.trim().to_string()))
                    }
                }
                Err(err) => {
                    if err.kind() == ErrorKind::NotFound {
                        (
                            false,
                            None,
                            Some("Claude Code CLI not found. Run 'npm install -g @anthropic-ai/claude-code'.".to_string()),
                        )
                    } else {
                        (false, None, Some(err.to_string()))
                    }
                }
            },
            Err(_) => (
                false,
                None,
                Some("Timed out while checking Claude Code CLI.".to_string()),
            ),
        };

    Ok(json!({
        "ok": node_ok && claude_ok,
        "nodeOk": node_ok,
        "nodeVersion": node_version,
        "nodeDetails": node_details,
        "claudeOk": claude_ok,
        "claudeVersion": claude_version,
        "claudeDetails": claude_details,
        "path": path_env,
    }))
}
