import { useState, useEffect, useCallback } from "react";
import type { SessionEntry } from "../types";
import {
  getVisibleSessions,
  scanAvailableSessions,
  importSessions as importSessionsApi,
  registryArchiveSession,
  getArchivedSessions,
  registryUnarchiveSession,
} from "../services/tauri";

/**
 * Hook for managing the session registry.
 *
 * Provides access to visible sessions for a workspace and functions
 * to import, archive, and refresh sessions.
 */
export function useRegistry(workspaceId: string | null) {
  const [visibleSessions, setVisibleSessions] = useState<SessionEntry[]>([]);
  const [availableSessions, setAvailableSessions] = useState<SessionEntry[]>(
    [],
  );
  const [archivedSessions, setArchivedSessions] = useState<SessionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Load visible sessions when workspace changes
  useEffect(() => {
    if (!workspaceId) {
      setVisibleSessions([]);
      return;
    }

    let active = true;
    setIsLoading(true);

    void (async () => {
      try {
        const sessions = await getVisibleSessions(workspaceId);
        if (active) {
          setVisibleSessions(sessions);
        }
      } catch (err) {
        console.error("Failed to load visible sessions:", err);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [workspaceId]);

  // Load archived sessions when showArchived is toggled on
  useEffect(() => {
    if (!workspaceId || !showArchived) {
      setArchivedSessions([]);
      return;
    }

    let active = true;
    void (async () => {
      try {
        const sessions = await getArchivedSessions(workspaceId);
        if (active) {
          setArchivedSessions(sessions);
        }
      } catch (err) {
        console.error("Failed to load archived sessions:", err);
      }
    })();

    return () => {
      active = false;
    };
  }, [workspaceId, showArchived]);

  // Scan for available sessions to import
  const scanForSessions = useCallback(async () => {
    if (!workspaceId) return;

    setIsScanning(true);
    try {
      const sessions = await scanAvailableSessions(workspaceId);
      // Filter out already visible sessions
      const visibleIds = new Set(visibleSessions.map((s) => s.sessionId));
      setAvailableSessions(
        sessions.filter((s) => !visibleIds.has(s.sessionId)),
      );
    } catch (err) {
      console.error("Failed to scan for sessions:", err);
    } finally {
      setIsScanning(false);
    }
  }, [workspaceId, visibleSessions]);

  // Import selected sessions
  const importSessions = useCallback(
    async (sessionIds: string[]) => {
      if (!workspaceId) return;

      const sessionsToImport = availableSessions.filter((s) =>
        sessionIds.includes(s.sessionId),
      );

      await importSessionsApi(workspaceId, sessionIds, sessionsToImport);

      // Update local state
      setVisibleSessions((prev) => [...prev, ...sessionsToImport]);
      setAvailableSessions((prev) =>
        prev.filter((s) => !sessionIds.includes(s.sessionId)),
      );
    },
    [workspaceId, availableSessions],
  );

  // Archive (hide) a session
  const archiveSession = useCallback(
    async (sessionId: string) => {
      if (!workspaceId) return;

      await registryArchiveSession(workspaceId, sessionId);

      // Update local state - move from visible to archived
      const session = visibleSessions.find((s) => s.sessionId === sessionId);
      setVisibleSessions((prev) =>
        prev.filter((s) => s.sessionId !== sessionId),
      );
      if (session && showArchived) {
        setArchivedSessions((prev) => [...prev, session]);
      }
    },
    [workspaceId, visibleSessions, showArchived],
  );

  // Unarchive (restore) a session to visibility
  const unarchiveSession = useCallback(
    async (sessionId: string) => {
      if (!workspaceId) return;

      await registryUnarchiveSession(workspaceId, sessionId);

      // Update local state - move from archived to visible
      const session = archivedSessions.find((s) => s.sessionId === sessionId);
      if (session) {
        setArchivedSessions((prev) =>
          prev.filter((s) => s.sessionId !== sessionId),
        );
        setVisibleSessions((prev) => [...prev, session]);
      }
    },
    [workspaceId, archivedSessions],
  );

  // Refresh visible sessions
  const refreshSessions = useCallback(async () => {
    if (!workspaceId) return;

    try {
      const sessions = await getVisibleSessions(workspaceId);
      setVisibleSessions(sessions);
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    }
  }, [workspaceId]);

  return {
    visibleSessions,
    availableSessions,
    archivedSessions,
    isLoading,
    isScanning,
    showArchived,
    setShowArchived,
    scanForSessions,
    importSessions,
    archiveSession,
    unarchiveSession,
    refreshSessions,
  };
}
