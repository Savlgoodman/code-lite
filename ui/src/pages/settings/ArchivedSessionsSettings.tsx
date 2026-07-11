import { useState } from "react";

import { RotateCcw, Trash2, X } from "lucide-react";

import { formatTimeLabel } from "../../lib/formatters";
import type { Session } from "../../types";
import type { SettingsPageProps } from "./types";

export function ArchivedSessionsSettings({
  archivedSessions,
  onDeleteArchivedSession,
  onRestoreArchivedSession
}: Pick<SettingsPageProps, "archivedSessions" | "onDeleteArchivedSession" | "onRestoreArchivedSession">) {
  const [deleteRequest, setDeleteRequest] = useState<
    { kind: "all"; sessions: Session[] } | { kind: "single"; session: Session } | null
  >(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());

  const isDeleting = deletingIds.size > 0;
  const deleteCount = deleteRequest?.kind === "all" ? deleteRequest.sessions.length : deleteRequest ? 1 : 0;
  const deleteTitle = deleteRequest?.kind === "single" ? deleteRequest.session.title : "";

  function requestDeleteAll() {
    if (archivedSessions.length === 0 || isDeleting) {
      return;
    }
    setDeleteError(null);
    setDeleteRequest({ kind: "all", sessions: archivedSessions });
  }

  async function confirmDeleteRequest() {
    if (!deleteRequest) {
      return;
    }

    const sessionsToDelete = deleteRequest.kind === "all" ? deleteRequest.sessions : [deleteRequest.session];
    setDeletingIds(new Set(sessionsToDelete.map((session) => session.id)));
    setDeleteError(null);
    try {
      for (const session of sessionsToDelete) {
        await onDeleteArchivedSession(session.id);
      }
      setDeleteRequest(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingIds(new Set());
    }
  }

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading with-action">
        <div>
          <span className="eyebrow">会话</span>
          <h1>归档会话</h1>
        </div>
        <button
          className="settings-danger-button"
          disabled={archivedSessions.length === 0 || isDeleting}
          onClick={requestDeleteAll}
          type="button"
        >
          <Trash2 size={14} />
          <span>全部删除</span>
        </button>
      </div>

      {deleteError ? <div className="settings-inline-error">删除失败：{deleteError}</div> : null}

      <div className="settings-list">
        {archivedSessions.length === 0 ? (
          <div className="settings-empty">暂无归档会话</div>
        ) : (
          archivedSessions.map((session) => (
            <article className="settings-archive-row" key={session.id}>
              <div>
                <strong>{session.title}</strong>
                {session.preview.trim() ? <span>{session.preview}</span> : null}
              </div>
              <time>{formatTimeLabel(session.updatedAt)}</time>
              <div className="settings-row-actions">
                <button
                  className="settings-secondary-button"
                  disabled={isDeleting}
                  onClick={() => onRestoreArchivedSession(session.id)}
                  type="button"
                >
                  <RotateCcw size={14} />
                  <span>恢复</span>
                </button>
                <button
                  className="settings-danger-button"
                  disabled={isDeleting}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteRequest({ kind: "single", session });
                  }}
                  type="button"
                >
                  <Trash2 size={14} />
                  <span>{deletingIds.has(session.id) ? "删除中" : "彻底删除"}</span>
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      {deleteRequest ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal settings-delete-dialog" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">危险操作</span>
                <h2>{deleteRequest.kind === "all" ? "彻底删除全部归档会话" : "彻底删除会话"}</h2>
              </div>
              <button
                aria-label="关闭"
                className="settings-icon-button"
                disabled={isDeleting}
                onClick={() => setDeleteRequest(null)}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-delete-dialog-body">
              {deleteRequest.kind === "all" ? (
                <p>将永久删除 {deleteCount} 个归档会话，删除后无法恢复。</p>
              ) : (
                <p>
                  将永久删除会话<strong>“{deleteTitle}”</strong>，删除后无法恢复。
                </p>
              )}
            </div>
            <div className="settings-modal-actions">
              <button
                className="settings-secondary-button"
                disabled={isDeleting}
                onClick={() => setDeleteRequest(null)}
                type="button"
              >
                <span>取消</span>
              </button>
              <button
                className="settings-danger-button solid"
                disabled={isDeleting}
                onClick={() => void confirmDeleteRequest()}
                type="button"
              >
                <Trash2 size={14} />
                <span>{isDeleting ? "删除中" : "确认删除"}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
