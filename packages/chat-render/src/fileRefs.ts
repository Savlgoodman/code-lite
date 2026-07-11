/**
 * 消息正文中的本地文件引用解析（纯逻辑，两端共享）。
 *
 * Markdown 链接 `[label](href)` 渲染到 `a` 组件时，用 classifyHref 判断该 href
 * 是否为本地文件引用并归类（图片 / Markdown / 代码 / 文本 / 外链）。只做分类，
 * 不读盘；真正读取内容走后端受控 RPC（fs.readFile）。
 */

export type FileRefKind = "image" | "markdown" | "code" | "text" | "external";

export interface FileRef {
  kind: FileRefKind;
  /** 规范化后的路径（去掉 file:// 前缀等），供 fs.readFile 使用。 */
  path: string;
  label: string;
  /** 小写扩展名（不含点），无扩展名为空串。 */
  ext: string;
  /** kind==="code" 时的高亮语言（streamdown/highlighter 用）。 */
  language?: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

/** 扩展名 → 代码高亮语言。命中即视为 code。 */
const CODE_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  dart: "dart",
  r: "r",
  scala: "scala",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** 一般当作文本打开的扩展名（无高亮）。 */
const TEXT_EXTS = new Set([
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "env",
  "conf",
  "cfg",
  "properties",
  "gitignore",
  "editorconfig",
]);

const EXTERNAL_SCHEME = /^(https?|mailto|tel|ftp):/i;
const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    // 无扩展名，或形如 ".gitignore" 的 dotfile：用整名做扩展名判断。
    if (base.startsWith(".")) return base.slice(1).toLowerCase();
    return "";
  }
  return base.slice(dot + 1).toLowerCase();
}

/** 去掉 file:// 前缀，返回本地路径；非 file scheme 原样返回。 */
function stripFileScheme(href: string): string {
  if (/^file:\/\//i.test(href)) {
    let rest = href.replace(/^file:\/\//i, "");
    // file:///C:/x → /C:/x，去掉多余前导斜杠还原 Windows 盘符路径。
    if (WINDOWS_ABS.test(rest.replace(/^\//, ""))) {
      rest = rest.replace(/^\//, "");
    }
    try {
      return decodeURIComponent(rest);
    } catch {
      return rest;
    }
  }
  return href;
}

function looksLikeLocalPath(href: string): boolean {
  if (WINDOWS_ABS.test(href)) return true;
  if (href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return true;
  if (href.startsWith("~/")) return true;
  // 带已知扩展名的裸相对路径（无 scheme、无空格）也算本地文件。
  if (!href.includes(" ") && !href.includes("://") && href.includes(".")) return true;
  return false;
}

/**
 * 判断 href 是否为本地文件引用并归类。
 * 返回 null 表示不是本地文件（外链或无法判定），调用方回退普通链接渲染。
 */
export function classifyHref(href: string, label: string): FileRef | null {
  const raw = (href ?? "").trim();
  if (!raw) return null;
  if (EXTERNAL_SCHEME.test(raw)) return null;
  if (raw.startsWith("#")) return null; // 页内锚点

  const isFileScheme = /^file:\/\//i.test(raw);
  if (!isFileScheme && !looksLikeLocalPath(raw)) return null;

  const path = stripFileScheme(raw);
  const ext = extOf(path);

  if (IMAGE_EXTS.has(ext)) {
    return { kind: "image", path, label, ext };
  }
  if (MARKDOWN_EXTS.has(ext)) {
    return { kind: "markdown", path, label, ext };
  }
  if (ext in CODE_LANGUAGES) {
    return { kind: "code", path, label, ext, language: CODE_LANGUAGES[ext] };
  }
  if (TEXT_EXTS.has(ext) || ext === "") {
    return { kind: "text", path, label, ext };
  }
  // 其它未知扩展名统一按文本打开。
  return { kind: "text", path, label, ext };
}
