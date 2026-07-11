import { Github, User, Check, X, Cpu, Smartphone } from "lucide-react";
import { Sheet } from "../components/ui";
import { getEnvironmentInfo } from "../lib/environment";

interface AboutSheetProps {
  onClose: () => void;
}

const PROJECT_URL = "https://github.com/Savlgoodman/code-lite";
const PROFILE_URL = "https://github.com/Savlgoodman";

/** 在系统浏览器打开外链（浏览器新标签 / 原生壳走系统默认处理）。 */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 关于页：应用信息 + 当前运行环境属性 + 项目/作者链接。 */
export function AboutSheet({ onClose }: AboutSheetProps) {
  const env = getEnvironmentInfo();

  return (
    <Sheet title="关于" onClose={onClose}>
      <div className="about-sheet">
        <div className="about-header">
          <span className="about-app-name">Code Lite Remote</span>
          <span className="about-app-desc">远程会话 · AI 对话</span>
        </div>

        <div className="about-section">
          <h4 className="about-section-title">运行环境</h4>
          <div className="about-rows">
            <div className="about-row">
              <span className="about-row-label"><Smartphone size={15} /> 环境</span>
              <span className="about-row-value">{env.label}</span>
            </div>
            <div className="about-row">
              <span className="about-row-label">平台</span>
              <span className="about-row-value">{env.platform}</span>
            </div>
            <div className="about-row">
              <span className="about-row-label">构建模式</span>
              <span className="about-row-value">{env.buildMode}</span>
            </div>
            <div className="about-row">
              <span className="about-row-label">独立 PWA</span>
              <span className="about-row-value">
                {env.standalone ? <Check size={15} className="about-yes" /> : <X size={15} className="about-no" />}
              </span>
            </div>
            <div className="about-row">
              <span className="about-row-label"><Cpu size={15} /> AI 对话</span>
              <span className="about-row-value">
                {env.aiAvailable ? (
                  <span className="about-yes about-inline"><Check size={15} /> 可用</span>
                ) : (
                  <span className="about-no about-inline"><X size={15} /> 仅 App 可用</span>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="about-section">
          <h4 className="about-section-title">链接</h4>
          <button className="about-link" onClick={() => openExternal(PROJECT_URL)} type="button">
            <Github size={18} />
            <span className="about-link-main">
              <span className="about-link-title">项目仓库</span>
              <span className="about-link-url">github.com/Savlgoodman/code-lite</span>
            </span>
          </button>
          <button className="about-link" onClick={() => openExternal(PROFILE_URL)} type="button">
            <User size={18} />
            <span className="about-link-main">
              <span className="about-link-title">作者主页</span>
              <span className="about-link-url">github.com/Savlgoodman</span>
            </span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}
