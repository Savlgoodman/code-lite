import { useEffect, useState } from "react";
import { ArrowUp, Folder, FolderPlus, HardDrive, Loader2, Check, X } from "lucide-react";
import type { ConversationClient, DirectoryListing } from "@code-lite/chat-core";

interface DirectoryBrowserProps {
  client: ConversationClient | null;
  /** 初始浏览路径，留空从 home 开始 */
  initialPath?: string;
  /** 选定某目录作为工作区 */
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** 浏览宿主机目录树，选择一个目录作为工作区路径。 */
export function DirectoryBrowser({ client, initialPath, onSelect, onClose }: DirectoryBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 新建文件夹：输入行显隐 + 名称 + 创建中
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const load = async (path?: string) => {
    if (!client) return;
    setLoading(true);
    setError(null);
    setShowNewFolder(false);
    setNewFolderName("");
    try {
      const result = await client.browseDirectory(path);
      setListing(result);
    } catch (err) {
      console.error("[DirectoryBrowser] browse failed:", err);
      setError("无法读取该目录");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!client || !listing?.path || !name || creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      await client.createDirectory(listing.path, name);
      // 重新加载当前目录以显示新建的文件夹
      const result = await client.browseDirectory(listing.path);
      setListing(result);
      setShowNewFolder(false);
      setNewFolderName("");
    } catch (err) {
      console.error("[DirectoryBrowser] mkdir failed:", err);
      setError("新建文件夹失败（可能已存在或名称非法）");
    } finally {
      setCreatingFolder(false);
    }
  };

  useEffect(() => {
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet dir-browser" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>选择目录</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* 当前路径 + 上级 + 新建文件夹 */}
        <div className="dir-browser-path">
          <button
            className="dir-up-btn"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && load(listing.parent)}
            aria-label="上级目录"
          >
            <ArrowUp size={16} />
          </button>
          <span className="dir-current-path" title={listing?.path}>
            {listing?.path || "…"}
          </span>
          <button
            className="dir-up-btn"
            disabled={!listing?.path || loading}
            onClick={() => {
              setShowNewFolder((v) => !v);
              setNewFolderName("");
              setError(null);
            }}
            aria-label="新建文件夹"
            title="在当前目录新建文件夹"
          >
            <FolderPlus size={16} />
          </button>
        </div>

        {/* 新建文件夹输入行 */}
        {showNewFolder && (
          <div className="dir-new-folder-row">
            <input
              className="form-input"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleCreateFolder(); }
                if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); }
              }}
              placeholder="新文件夹名称"
              autoFocus
              spellCheck={false}
            />
            <button
              className="dir-up-btn"
              disabled={!newFolderName.trim() || creatingFolder}
              onClick={handleCreateFolder}
              aria-label="确认新建"
            >
              {creatingFolder ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            </button>
            <button
              className="dir-up-btn"
              onClick={() => { setShowNewFolder(false); setNewFolderName(""); }}
              aria-label="取消新建"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="modal-body dir-browser-body">
          {loading ? (
            <div className="dir-browser-loading"><Loader2 size={18} className="spin" /> 加载中…</div>
          ) : error ? (
            <div className="dir-browser-error">{error}</div>
          ) : (
            <ul className="dir-list">
              {/* 盘符（Windows，仅在有的时候显示） */}
              {listing?.drives.map((d) => (
                <li key={d.path} className="dir-item" onClick={() => load(d.path)}>
                  <HardDrive size={16} />
                  <span>{d.name}</span>
                </li>
              ))}
              {listing?.entries.length === 0 && listing.drives.length === 0 && (
                <li className="dir-empty">此目录下没有子文件夹</li>
              )}
              {listing?.entries.map((entry) => (
                <li key={entry.path} className="dir-item" onClick={() => load(entry.path)}>
                  <Folder size={16} />
                  <span>{entry.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn-primary"
            disabled={!listing?.path}
            onClick={() => listing?.path && onSelect(listing.path)}
          >
            <Check size={16} /> 选此目录
          </button>
        </div>
      </div>
    </div>
  );
}
