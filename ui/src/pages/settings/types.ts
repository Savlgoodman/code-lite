import type { Session } from "../../types";

export type SettingsSection =
  | "appearance"
  | "features"
  | "agents"
  | "acp"
  | "providers"
  | "imageProviders"
  | "logs"
  | "archive"
  | "remote"
  | "about";

export interface SettingsPageProps {
  archivedSessions: Session[];
  initialSection?: SettingsSection;
  onBack: () => void;
  onDeleteArchivedSession: (sessionId: string) => Promise<void>;
  onRestoreArchivedSession: (sessionId: string) => void;
}
