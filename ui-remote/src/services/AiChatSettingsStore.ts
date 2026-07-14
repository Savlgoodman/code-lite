import { Preferences } from "@capacitor/preferences";

const SETTINGS_KEY = "ai-chat-settings";

export const AI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export interface AiChatSettings {
  reasoningEffort: AiReasoningEffort | null;
}

const DEFAULT_SETTINGS: AiChatSettings = {
  reasoningEffort: null,
};

function normalizeSettings(value: unknown): AiChatSettings {
  const raw = value && typeof value === "object" ? value as Partial<AiChatSettings> : {};
  const reasoningEffort = AI_REASONING_EFFORTS.find((effort) => effort === raw.reasoningEffort) ?? null;
  return { reasoningEffort };
}

function parseSettings(raw: string | null): AiChatSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export class AiChatSettingsStore {
  private settings = parseSettings(localStorage.getItem(SETTINGS_KEY));
  private loaded = false;
  private loading: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AiChatSettings => this.settings;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const pref = await Preferences.get({ key: SETTINGS_KEY });
      this.settings = parseSettings(pref.value ?? localStorage.getItem(SETTINGS_KEY));
      this.loaded = true;
      this.emit();
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async update(patch: Partial<AiChatSettings>): Promise<void> {
    await this.init();
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    const json = JSON.stringify(this.settings);
    await Preferences.set({ key: SETTINGS_KEY, value: json });
    localStorage.setItem(SETTINGS_KEY, json);
    this.emit();
  }
}

export const aiChatSettingsStore = new AiChatSettingsStore();
