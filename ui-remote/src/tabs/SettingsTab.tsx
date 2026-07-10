export function SettingsTab() {
  return (
    <div className="tab-page">
      <h2 className="page-title">设置</h2>
      <div className="settings-list">
        <div className="settings-section">
          <h3>AI 配置</h3>
          <ul>
            <li className="settings-item">API URL</li>
            <li className="settings-item">API Key</li>
            <li className="settings-item">默认模型</li>
            <li className="settings-item">Temperature</li>
          </ul>
        </div>
        <div className="settings-section">
          <h3>远程配置</h3>
          <ul>
            <li className="settings-item">默认 Relay URL</li>
            <li className="settings-item">自动重连</li>
            <li className="settings-item">心跳间隔</li>
          </ul>
        </div>
        <div className="settings-section">
          <h3>通用</h3>
          <ul>
            <li className="settings-item">主题</li>
            <li className="settings-item">语言</li>
            <li className="settings-item">通知权限</li>
            <li className="settings-item">关于 Code-Lite Remote</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
