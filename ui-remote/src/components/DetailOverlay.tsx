import type { FileRef } from "@code-lite/chat-render";
import { ToolDetailPage } from "../pages/ToolDetailPage";
import { DiffDetailPage } from "../pages/DiffDetailPage";
import { FileRefDetailPage } from "../pages/FileRefDetailPage";
import type { DiffDetailTarget, ToolDetailTarget } from "./AssistantToolFlow";

export interface FileRefDetailTarget {
  fileRef: FileRef;
  conversationId: string;
}

export type DetailRoute =
  | { kind: "tool"; target: ToolDetailTarget }
  | { kind: "diff"; target: DiffDetailTarget }
  | { kind: "fileref"; target: FileRefDetailTarget };

/**
 * DetailContent — 会话内工具/diff/文件引用详情页的页面切换。
 *
 * 转场与栈管理已上交给导航栈（navStore 的 "detail" 条目 + NavHost 的
 * ScreenTransition），本组件只负责按 route.kind 渲染对应详情页。
 */
export function DetailContent({ route, onBack }: { route: DetailRoute; onBack: () => void }) {
  switch (route.kind) {
    case "tool":
      return <ToolDetailPage tool={route.target.tool} onBack={onBack} />;
    case "diff":
      return (
        <DiffDetailPage
          diff={route.target.diff}
          conversationId={route.target.conversationId}
          onBack={onBack}
        />
      );
    case "fileref":
      return (
        <FileRefDetailPage
          fileRef={route.target.fileRef}
          conversationId={route.target.conversationId}
          onBack={onBack}
        />
      );
  }
}
