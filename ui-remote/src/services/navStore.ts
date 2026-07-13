/**
 * navStore — ui-remote 的中央导航栈（单例，无框架依赖）
 *
 * 全应用只有一份「全屏层级」真源：底部 Tab 是根基座，其上叠加的所有整页
 * （会话页、AI 对话页、模型供应商配置及其子页、已归档页、会话内详情页）都作为
 * 栈条目存在。push/pop/replace/reset 是唯一的导航动词。
 *
 * 设计目标：
 * - 安卓返回键 / 浏览器 popstate 有确定的东西可弹（见 hooks/useSystemBack）。
 * - 新增页面只需定义一个 ScreenEntry 变体，转场由 NavHost + ScreenTransition 统一处理，
 *   不必每个页面各写一套进出场动画。
 *
 * 瞬态层（Sheet / 全屏预览等）不进这个栈，而是经 registerDismissable 注册一个
 * 关闭回调；返回键优先关闭最上层瞬态层，再回落到 pop 栈。详见 hooks/useDismissable。
 */

import type { AiProvider } from "./AiProviderStore";
import type { ImageProviderRecord } from "./ImageProviderStore";
import type { DetailRoute } from "../components/DetailOverlay";

/**
 * 栈条目：每个变体对应一个整页。kind 决定 NavHost 渲染哪个页面组件，
 * 其余字段是该页面所需的参数。新增页面时在此扩展一个变体即可。
 */
export type ScreenEntry =
  | { kind: "chat"; sessionId: string }
  | { kind: "aiChat"; conversationId: string }
  | { kind: "aiSettings" }
  | { kind: "aiSettingsProviderForm"; provider: AiProvider | null }
  | { kind: "aiSettingsPickModels"; provider: AiProvider }
  | { kind: "aiArchived" }
  | { kind: "imageGen"; recordId: string }
  | { kind: "imageProviders" }
  | { kind: "imageProviderForm"; provider: ImageProviderRecord | null }
  | { kind: "detail"; route: DetailRoute };

/** 关闭瞬态层（Sheet/预览）的回调。返回后应触发该层的离场动画并卸载。 */
export type DismissHandler = () => void;

/** 栈项：给每个页面附一个稳定 key，供 React 列表与 NavHost 的离场追踪用。 */
export interface StackItem {
  key: number;
  entry: ScreenEntry;
}

type Listener = () => void;

interface DismissableEntry {
  id: number;
  dismiss: DismissHandler;
}

class NavStore {
  private screens: StackItem[] = [];
  private dismissables: DismissableEntry[] = [];
  private listeners = new Set<Listener>();
  private nextDismissableId = 1;
  private nextScreenKey = 1;
  /** 快照缓存：useSyncExternalStore 要求同一状态返回同一引用，避免无限重渲染。 */
  private snapshot: StackItem[] = this.screens;

  // ── 订阅（供 useSyncExternalStore 用）──

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StackItem[] => this.snapshot;

  private emit() {
    this.snapshot = this.screens.slice();
    for (const listener of this.listeners) listener();
  }

  // ── 栈操作 ──

  /** 压入一个新页面。 */
  push(entry: ScreenEntry) {
    this.screens.push({ key: this.nextScreenKey++, entry });
    this.emit();
  }

  /** 弹出栈顶页面；已在根（空栈）时无操作。返回是否真的弹出了。 */
  pop(): boolean {
    if (this.screens.length === 0) return false;
    this.screens.pop();
    this.emit();
    return true;
  }

  /** 替换栈顶页面（用于同级跳转，如供应商表单保存后进入选模型）。 */
  replaceTop(entry: ScreenEntry) {
    if (this.screens.length === 0) {
      this.push(entry);
      return;
    }
    this.screens[this.screens.length - 1] = { key: this.nextScreenKey++, entry };
    this.emit();
  }

  /** 清空整个栈，回到 Tab 根。 */
  reset() {
    if (this.screens.length === 0) return;
    this.screens = [];
    this.emit();
  }

  /** 当前栈深度（0 表示在 Tab 根）。 */
  depth(): number {
    return this.screens.length;
  }

  // ── 瞬态层（Sheet / 预览）注册 ──

  /**
   * 注册一个瞬态层的关闭回调，返回注销函数。
   * back() 会优先调用最后注册（最上层）的 dismiss。
   */
  registerDismissable(dismiss: DismissHandler): () => void {
    const id = this.nextDismissableId++;
    this.dismissables.push({ id, dismiss });
    return () => {
      this.dismissables = this.dismissables.filter((d) => d.id !== id);
    };
  }

  private dismissTop(): boolean {
    const top = this.dismissables[this.dismissables.length - 1];
    if (!top) return false;
    // dismiss 回调内部会走离场动画并最终注销自己，这里不主动移除。
    top.dismiss();
    return true;
  }

  /**
   * 统一返回：优先关闭最上层瞬态层，其次弹出栈顶页面。
   * 返回 true 表示消费了这次返回；false 表示已在根且无可关闭层
   * （调用方据此决定是否放行退出 App）。
   */
  back(): boolean {
    if (this.dismissTop()) return true;
    return this.pop();
  }

  /** 是否还有任何可返回的层级（页面栈或瞬态层）。 */
  canGoBack(): boolean {
    return this.screens.length > 0 || this.dismissables.length > 0;
  }
}

export const navStore = new NavStore();
