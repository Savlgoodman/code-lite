import { useEffect, useState } from "react";
import { ScreenTransition } from "./ui";
import { useNav } from "../hooks/useNav";
import { navStore, type StackItem } from "../services/navStore";
import { ChatPage } from "../pages/ChatPage";
import { AiChatPage } from "../pages/AiChatPage";
import { AiArchivedPage } from "../pages/AiArchivedPage";
import {
  AiSettingsListPage,
  AiProviderFormPage,
  AiPickModelsPage,
} from "../pages/AiSettingsPage";
import { ImageGenPage } from "../pages/ImageGenPage";
import { ImageProvidersListPage, ImageProviderFormPage } from "../pages/ImageProvidersPage";
import { DetailContent } from "./DetailOverlay";

/**
 * NavHost — 遍历导航栈渲染整页层级。
 *
 * 每个栈条目套一层 ScreenTransition（右滑入 / 返回时推出）。已弹出的条目在离场
 * 动画期间保留在 rendered 中（追加在末尾即在最上层），动画结束后再卸载。
 * 所有页面的返回都走 navStore.pop（系统返回键另经 useSystemBack 走 back）。
 */
export function NavHost() {
  const { stack } = useNav();
  const [rendered, setRendered] = useState<StackItem[]>(stack);

  useEffect(() => {
    setRendered((prev) => {
      const liveKeys = new Set(stack.map((s) => s.key));
      // 仍在离场（已不在栈中但尚未卸载）的条目，保留在末尾以叠在最上层滑出。
      const exiting = prev.filter((p) => !liveKeys.has(p.key));
      return [...stack, ...exiting];
    });
  }, [stack]);

  const liveKeys = new Set(stack.map((s) => s.key));
  const pop = () => navStore.pop();

  return (
    <>
      {rendered.map((item) => (
        <ScreenTransition
          key={item.key}
          show={liveKeys.has(item.key)}
          onExited={() => setRendered((prev) => prev.filter((r) => r.key !== item.key))}
          from={item.entry.kind === "detail" ? "right" : "right"}
          className="nav-screen"
        >
          <ScreenBody item={item} onBack={pop} />
        </ScreenTransition>
      ))}
    </>
  );
}

function ScreenBody({ item, onBack }: { item: StackItem; onBack: () => void }) {
  const entry = item.entry;
  switch (entry.kind) {
    case "chat":
      return <ChatPage sessionId={entry.sessionId} onBack={onBack} />;
    case "aiChat":
      return <AiChatPage conversationId={entry.conversationId} onBack={onBack} />;
    case "aiSettings":
      return <AiSettingsListPage onBack={onBack} />;
    case "aiSettingsProviderForm":
      return <AiProviderFormPage provider={entry.provider} onBack={onBack} />;
    case "aiSettingsPickModels":
      return <AiPickModelsPage provider={entry.provider} onBack={onBack} />;
    case "aiArchived":
      return <AiArchivedPage onBack={onBack} />;
    case "imageGen":
      return <ImageGenPage recordId={entry.recordId} onBack={onBack} />;
    case "imageProviders":
      return <ImageProvidersListPage onBack={onBack} />;
    case "imageProviderForm":
      return <ImageProviderFormPage provider={entry.provider} onBack={onBack} />;
    case "detail":
      return <DetailContent route={entry.route} onBack={onBack} />;
  }
}
