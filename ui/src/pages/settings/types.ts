import type { Session } from "../../types";

export type SettingsSection = "agents" | "acp" | "providers" | "logs" | "archive" | "about";

export interface SettingsPageProps {
  archivedSessions: Session[];
  onBack: () => void;
  onDeleteArchivedSession: (sessionId: string) => Promise<void>;
  onRestoreArchivedSession: (sessionId: string) => void;
}
