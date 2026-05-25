/** Non-secret LLM provider config persisted on disk. */
export interface LlmConfig {
  /** Free-form provider label ("openai", "ollama", ...). */
  provider: string;
  /** Base URL for the OpenAI-compatible API (no trailing slash). */
  base_url: string;
  /** Default model name. */
  model: string;
  /** Sampling temperature for generated queries. */
  temperature: number;
}

/** Payload sent to `save_llm_config`. Empty `api_key` keeps the stored one. */
export interface LlmConfigInput extends LlmConfig {
  api_key: string;
}

/** Safety / guard-rail preferences. */
export interface SafetyConfig {
  /** When `true`, the UI asks before running destructive SQL. */
  confirm_destructive: boolean;
}

/** What `get_settings` / `save_llm_config` return. */
export interface SettingsView {
  llm: LlmConfig;
  /** `true` when an API key is currently stored in the keyring. */
  llm_api_key_configured: boolean;
  safety: SafetyConfig;
}

/** Outcome of `test_llm_config`. */
export interface LlmConnectivity {
  models: string[];
}
