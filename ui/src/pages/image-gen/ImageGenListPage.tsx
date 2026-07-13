import { useEffect, useMemo, useState } from "react";

import { ImageOff, Plus, Settings, Trash2 } from "lucide-react";

import type { ImageGenRecordSummary } from "@code-lite/image-gen";

import { getImageGenClient, resolveImageUrl } from "../../services/imageGenStore";
import "./ImageGenListPage.css";

interface ImageGenListPageProps {
  onOpenSettings: () => void;
  onOpenRecord: (recordId: string) => void;
  onCreateRecord: () => void;
}

function formatTime(value: number | undefined): string {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleString();
}

function ImageGenCard({
  record,
  onOpen,
  onDelete
}: {
  record: ImageGenRecordSummary;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [cover, setCover] = useState("");

  useEffect(() => {
    let cancelled = false;
    void resolveImageUrl(record.latestImageUrl).then((url) => {
      if (!cancelled) {
        setCover(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [record.latestImageUrl]);

  return (
    <article className="imggen-card">
      <button className="imggen-card-cover" onClick={onOpen} type="button">
        {cover ? (
          <img alt={record.title} src={cover} />
        ) : (
          <span className="imggen-card-placeholder">
            <ImageOff size={28} />
          </span>
        )}
      </button>
      <div className="imggen-card-footer">
        <strong title={record.title}>{record.title}</strong>
        <span>{formatTime(record.updatedAt)}</span>
      </div>
      <button className="imggen-card-delete" onClick={onDelete} title="删除任务" type="button">
        <Trash2 size={14} />
      </button>
    </article>
  );
}

export function ImageGenListPage({ onOpenSettings, onOpenRecord, onCreateRecord }: ImageGenListPageProps) {
  const client = useMemo(() => getImageGenClient(), []);
  const [records, setRecords] = useState<ImageGenRecordSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setRecords(await client.listRecords());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deleteRecord(recordId: string) {
    if (!window.confirm("确定删除这个图片生成任务吗？")) {
      return;
    }
    setBusyId(recordId);
    try {
      await client.deleteRecord(recordId);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="imggen-list">
      <header className="imggen-list-header">
        <div>
          <span className="imggen-eyebrow">工作台</span>
          <h1>图片生成</h1>
        </div>
        <div className="imggen-list-actions">
          <button className="imggen-icon-button" onClick={onOpenSettings} title="图片生成供应商配置" type="button">
            <Settings size={16} />
          </button>
          <button className="imggen-primary-button" onClick={onCreateRecord} type="button">
            <Plus size={16} />
            <span>新建任务</span>
          </button>
        </div>
      </header>

      {error ? <div className="imggen-inline-error">{error}</div> : null}

      {records.length === 0 ? (
        <div className="imggen-empty">还没有生成记录，点右上角加号新建。</div>
      ) : (
        <div className="imggen-card-grid">
          {records.map((record) => (
            <ImageGenCard
              key={record.id}
              onDelete={() => (busyId === record.id ? undefined : void deleteRecord(record.id))}
              onOpen={() => onOpenRecord(record.id)}
              record={record}
            />
          ))}
        </div>
      )}
    </section>
  );
}
