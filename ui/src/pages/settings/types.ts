import type { Session } from "../../types";

export type SettingsSection = "appearance" | "agents" | "acp" | "providers" | "logs" | "archive" | "remote" | "about";

export interface SettingsPageProps {
  archivedSessions: Session[];
  onBack: () => void;
  onDeleteArchivedSession: (sessionId: string) => Promise<void>;
  onRestoreArchivedSession: (sessionId: string) => void;
}
