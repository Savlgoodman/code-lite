import { useState } from "react";

import { AboutSettings } from "./AboutSettings";
import { AcpConnectionSettings } from "./AcpConnectionSettings";
import { AgentRuntimeSettings } from "./AgentRuntimeSettings";
import { ArchivedSessionsSettings } from "./ArchivedSessionsSettings";
import { LogsSettings } from "./LogsSettings";
import { ModelProvidersSettings } from "./ModelProvidersSettings";
import { RemoteControlSettings } from "./RemoteControlSettings";
import { SettingsLayout } from "./SettingsLayout";
import type { SettingsPageProps, SettingsSection } from "./types";
import "./SettingsPage.css";

export function SettingsPage({
  archivedSessions,
  onBack,
  onDeleteArchivedSession,
  onRestoreArchivedSession
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("agents");

  return (
    <SettingsLayout activeSection={activeSection} onBack={onBack} onSectionChange={setActiveSection}>
      {activeSection === "agents" ? <AgentRuntimeSettings /> : null}
      {activeSection === "acp" ? <AcpConnectionSettings /> : null}
      {activeSection === "providers" ? <ModelProvidersSettings /> : null}
      {activeSection === "logs" ? <LogsSettings /> : null}
      {activeSection === "archive" ? (
        <ArchivedSessionsSettings
          archivedSessions={archivedSessions}
          onDeleteArchivedSession={onDeleteArchivedSession}
          onRestoreArchivedSession={onRestoreArchivedSession}
        />
      ) : null}
      {activeSection === "remote" ? <RemoteControlSettings /> : null}
      {activeSection === "about" ? <AboutSettings /> : null}
    </SettingsLayout>
  );
}
