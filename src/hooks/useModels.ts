import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DebugEntry, ModelOption, WorkspaceInfo } from "../types";
import { claudeListModels } from "../services/tauri";

/**
 * Format Claude model ID into a human-readable display name.
 * e.g., "claude-3-5-sonnet-20241022" -> "Claude 3.5 Sonnet"
 */
function formatClaudeModelName(modelId: string): string {
  if (!modelId) return "";
  // Remove date suffix (e.g., -20241022)
  const withoutDate = modelId.replace(/-\d{8}$/, "");
  // Split by hyphens and capitalize
  const parts = withoutDate.split("-");
  const formatted = parts
    .map((part, index) => {
      // Handle version numbers like "3-5" -> "3.5"
      if (/^\d+$/.test(part) && /^\d+$/.test(parts[index + 1] || "")) {
        return part + ".";
      }
      if (/^\d+$/.test(part) && /^\d+$/.test(parts[index - 1] || "")) {
        return part;
      }
      // Capitalize first letter
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ")
    .replace(/\s+\./g, ".")
    .replace(/\.\s+/g, ".");
  return formatted;
}

type UseModelsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onDebug?: (entry: DebugEntry) => void;
};

export function useModels({ activeWorkspace, onDebug }: UseModelsOptions) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  const lastFetchedWorkspaceId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const workspaceId = activeWorkspace?.id ?? null;
  const isConnected = Boolean(activeWorkspace?.connected);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const reasoningOptions = useMemo(() => {
    if (!selectedModel) {
      return [];
    }
    return selectedModel.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    );
  }, [selectedModel]);

  const refreshModels = useCallback(async () => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    onDebug?.({
      id: `${Date.now()}-client-model-list`,
      timestamp: Date.now(),
      source: "client",
      label: "claude/model-list",
      payload: { workspaceId },
    });
    try {
      const response = await claudeListModels();
      onDebug?.({
        id: `${Date.now()}-server-model-list`,
        timestamp: Date.now(),
        source: "server",
        label: "claude/model-list response",
        payload: response,
      });
      // Parse Claude model list - handles various response formats
      // Use any to handle potential variations in response shape from different Claude versions
      const resp = response as any;
      const rawData =
        resp.result?.models ??
        resp.models ??
        resp.result?.data ??
        resp.data ??
        [];
      const data: ModelOption[] = rawData.map((item: any) => {
        const modelId = String(item.id ?? item.model ?? "");
        // Generate display name from model ID (e.g., "claude-3-5-sonnet-20241022" -> "Claude 3.5 Sonnet")
        const displayName =
          item.displayName ??
          item.display_name ??
          item.name ??
          formatClaudeModelName(modelId);
        return {
          id: modelId,
          model: modelId,
          displayName: String(displayName),
          description: String(item.description ?? ""),
          supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts)
            ? item.supportedReasoningEfforts
            : Array.isArray(item.supported_reasoning_efforts)
              ? item.supported_reasoning_efforts.map((effort: any) => ({
                  reasoningEffort: String(
                    effort.reasoningEffort ?? effort.reasoning_effort ?? "",
                  ),
                  description: String(effort.description ?? ""),
                }))
              : [],
          defaultReasoningEffort: String(
            item.defaultReasoningEffort ?? item.default_reasoning_effort ?? "",
          ),
          isDefault: Boolean(item.isDefault ?? item.is_default ?? false),
        };
      });
      setModels(data);
      lastFetchedWorkspaceId.current = workspaceId;
      // Prefer Claude Sonnet as default, fall back to first model
      const preferredModel =
        data.find((model) => model.model.includes("sonnet")) ?? null;
      const defaultModel =
        preferredModel ?? data.find((model) => model.isDefault) ?? data[0] ?? null;
      if (defaultModel) {
        setSelectedModelId(defaultModel.id);
        setSelectedEffort(defaultModel.defaultReasoningEffort ?? null);
      }
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-model-list-error`,
        timestamp: Date.now(),
        source: "error",
        label: "claude/model-list error",
        payload: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.current = false;
    }
  }, [isConnected, onDebug, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (lastFetchedWorkspaceId.current === workspaceId && models.length > 0) {
      return;
    }
    refreshModels();
  }, [isConnected, models.length, refreshModels, workspaceId]);

  useEffect(() => {
    if (!selectedModel) {
      return;
    }
    if (
      selectedEffort &&
      selectedModel.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === selectedEffort,
      )
    ) {
      return;
    }
    setSelectedEffort(selectedModel.defaultReasoningEffort ?? null);
  }, [selectedEffort, selectedModel]);

  return {
    models,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
    reasoningOptions,
    selectedEffort,
    setSelectedEffort,
    refreshModels,
  };
}
