/**
 * @code-lite/chat-render —— 桌面与远端共享的聊天渲染纯逻辑。
 *
 * 只放「数据 → 视图模型」的纯函数与类型，不含 React 组件、不含样式、
 * 不 import 任一端的 service/hook。两端各自实现展示层，共用此处的计算。
 */

export * from "./fileDiffs";
export * from "./grouping";
