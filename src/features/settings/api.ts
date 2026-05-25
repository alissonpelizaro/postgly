import { invoke } from "@tauri-apps/api/core";

import type {
  LlmConfigInput,
  LlmConnectivity,
  SafetyConfig,
  SettingsView,
} from "./types";

/** Typed wrappers around the Rust settings commands. */
export const settingsApi = {
  /** Fetch the full settings document plus the secret-presence flag. */
  get: () => invoke<SettingsView>("get_settings"),

  /** Persist the LLM provider config. Empty `api_key` keeps the stored one. */
  saveLlm: (input: LlmConfigInput) =>
    invoke<SettingsView>("save_llm_config", { input }),

  /** Drop the stored LLM API key. Other LLM fields stay. */
  clearLlmApiKey: () => invoke<void>("clear_llm_api_key"),

  /** Probe `{base_url}/models` without persisting anything. */
  testLlm: (input: LlmConfigInput) =>
    invoke<LlmConnectivity>("test_llm_config", { input }),

  /** Persist the safety preferences (destructive-SQL confirm toggle). */
  saveSafety: (input: SafetyConfig) =>
    invoke<SettingsView>("save_safety_config", { input }),
};
