import { useEffect, useState } from "react";
import type { SessionEntry, WorkspaceInfo } from "../types";
import { scanAvailableSessions, importSessions } from "../services/tauri";

type ImportSessionsModalProps = {
  workspace: WorkspaceInfo;
  onClose: () => void;
  onImported: () => void;
};

export function ImportSessionsModal({
  workspace,
  onClose,
  onImported,
}: ImportSessionsModalProps) {
  const [isScanning, setIsScanning] = useState(true);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsScanning(true);
    setError(null);

    void (async () => {
      try {
        const found = await scanAvailableSessions(workspace.id);
        if (active) {
          setSessions(found);
          // Pre-select all by default
          setSelectedIds(new Set(found.map((s) => s.sessionId)));
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (active) {
          setIsScanning(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [workspace.id]);

  function toggleSession(sessionId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === sessions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sessions.map((s) => s.sessionId)));
    }
  }

  async function handleImport() {
    if (selectedIds.size === 0) return;

    setIsImporting(true);
    setError(null);

    try {
      const toImport = sessions.filter((s) => selectedIds.has(s.sessionId));
      await importSessions(
        workspace.id,
        Array.from(selectedIds),
        toImport
      );
      onImported();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  }

  function formatDate(timestamp: number) {
    if (!timestamp) return "Unknown";
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="import-sessions-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-sessions-title"
      >
        <h2 id="import-sessions-title" className="import-sessions-title">
          Import Sessions
        </h2>
        <p className="import-sessions-subtitle">
          Import existing Claude sessions from {workspace.name}
        </p>

        {isScanning && (
          <div className="import-sessions-loading">
            Scanning for sessions...
          </div>
        )}

        {error && <div className="import-sessions-error">{error}</div>}

        {!isScanning && sessions.length === 0 && !error && (
          <div className="import-sessions-empty">
            No sessions found for this workspace.
          </div>
        )}

        {!isScanning && sessions.length > 0 && (
          <>
            <div className="import-sessions-header">
              <label className="import-sessions-select-all">
                <input
                  type="checkbox"
                  checked={selectedIds.size === sessions.length}
                  onChange={toggleAll}
                />
                Select all ({sessions.length})
              </label>
            </div>
            <div className="import-sessions-list">
              {sessions.map((session) => (
                <label
                  key={session.sessionId}
                  className="import-sessions-item"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(session.sessionId)}
                    onChange={() => toggleSession(session.sessionId)}
                  />
                  <div className="import-sessions-item-content">
                    <span className="import-sessions-item-preview">
                      {session.preview || `Session ${session.sessionId.slice(0, 8)}`}
                    </span>
                    <span className="import-sessions-item-date">
                      {formatDate(session.lastActivity)}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="import-sessions-actions">
          <button
            className="ghost"
            onClick={onClose}
            disabled={isImporting}
          >
            Cancel
          </button>
          <button
            className="primary"
            onClick={handleImport}
            disabled={isScanning || isImporting || selectedIds.size === 0}
          >
            {isImporting
              ? "Importing..."
              : `Import ${selectedIds.size} session${selectedIds.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
