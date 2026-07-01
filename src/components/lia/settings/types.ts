// ============================================================================
// Shared types for settings tabs.
// ============================================================================

import type { AvatarConfig } from '@/lib/avatar-config';

export type Settings = {
  baseUrl: string;
  model: string;
  embedModel: string;
  ollamaOk: boolean;
  ollamaError?: string;
  availableModels: string[];
  availableEmbedModels: string[];
  vrmFiles: string[];
  activeVrm: string | null;
  avatarMode: string;
  avatarConfig: AvatarConfig;
};

export type RLStats = {
  sidecar_ok: boolean;
  sidecar_stats?: {
    transitions_count: number;
    model_versions: Array<{
      version: number;
      size_onnx_kb: number;
      created_at: number;
    }>;
    active_version: number | null;
  };
  sidecar_error?: string;
  local_experiences: number;
};
