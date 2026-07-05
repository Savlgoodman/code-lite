export type ChatConfigValue = string | number | boolean;

export interface SessionConfig {
  modelFamily: string;
  accessMode: string;
  reasoningEffort: string;
  selectedConfig: Record<string, ChatConfigValue>;
}
