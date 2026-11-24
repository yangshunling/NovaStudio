/**
 * Office 文档查看器入口（独立页面）
 *
 * 这个页面不参与主界面的 React 树，只负责把 file-viewer 挂起来：
 * - Word / Excel / PPT / PDF 四条渲染链路；
 * - 资源（Worker / WASM / 字体）从同源的 `../file-viewer/` 加载；
 * - 文档字节由 `nova-preview://` 提供，查看器自己 fetch。
 *
 * 为什么要单独一页：Worker 脚本要求与页面同源，主窗口是 file://，
 * 直接在主窗口里跑会被 Chromium 拒绝。生产环境由主进程在 127.0.0.1 的
 * 随机端口上提供本页与运行时资源（main/viewer/server.ts），主界面用
 * iframe 嵌进来。
 *
 * 与宿主的通信：
 *   宿主 → 页面：查询参数 src / name / theme
 *   页面 → 宿主：nova:viewer-mounted / nova:viewer-ready / nova:viewer-error
 */

import { mountViewer, type ViewerOptions } from "@file-viewer/web";
import { setDefaultFileViewerAssetBaseUrl } from "@file-viewer/core/assets";
import { wordRenderer } from "@file-viewer/renderer-word";
import { spreadsheetRenderer } from "@file-viewer/renderer-spreadsheet";
import { presentationRenderer } from "@file-viewer/renderer-presentation";
import { pdfRenderer } from "@file-viewer/renderer-pdf";

const params = new URLSearchParams(window.location.search);
const source = params.get("src")?.trim() ?? "";
const name = params.get("name") ?? undefined;
const theme = params.get("theme") === "light" ? "light" : "dark";

const container = document.getElementById("app");
if (!container) throw new Error("查看器容器缺失");

/**
 * 资源基址：页面在 `/viewer/index.html`，运行时资源在 `/file-viewer/`。
 * 无论开发（dev server）还是生产（回环服务），两者都与本页同源。
 */
setDefaultFileViewerAssetBaseUrl(
  new URL("../file-viewer/", window.location.href).href,
);

function post(message: Record<string, unknown>): void {
  window.parent?.postMessage(message, "*");
}

/** 便于在浏览器里做冒烟验证：把查看器状态写到 <html data-viewer-state> */
function markState(state: "mounted" | "ready" | "error"): void {
  document.documentElement.dataset.viewerState = state;
}

/**
 * 允许的文档地址：主进程的 nova-preview://，以及与本页同源的 http(s)
 * 地址（仅用于开发 / 冒烟测试；生产环境的同源地址只暴露查看器资源，
 * 不会出现工作区文档）。
 */
function isAllowedSource(candidate: string): boolean {
  if (candidate.startsWith("nova-preview://")) return true;
  return candidate.startsWith(`${window.location.origin}/`);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || "预览失败";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "预览失败";
  }
}

function reportError(message: string): void {
  markState("error");
  post({ type: "nova:viewer-error", message });
}

/*
 * 只接受主进程的预览协议（开发 / 冒烟测试额外允许同源地址）：页面本身
 * 可被任意构造，不能在查询参数里塞 remote URL 让查看器去请求。
 */
if (!source) {
  reportError("缺少文件地址");
} else if (!isAllowedSource(source)) {
  reportError("不支持的文件地址");
} else {
  let readySent = false;
  let errorSent = false;

  try {
    mountViewer(
      container,
      {
        url: source,
        name,
        options: {
          locale: "zh-CN",
          theme,
          /*
           * 按需装配：只带 Office 三件套 + PDF，避免把整套预设打进包里。
           * 各 renderer 的 handler 泛型固定为 HTMLDivElement，而公共选项里
           * 收窄成 HTMLElement，库自身的类型声明在这里对不上，按文档用法
           * 传入即可，这里只在类型层做一次收敛。
           */
          renderers: [
            wordRenderer,
            spreadsheetRenderer,
            presentationRenderer,
            pdfRenderer,
          ] as unknown as ViewerOptions["renderers"],
          /*
           * 下载 / 打印 / 导出在 Electron 里会走 window.open 或系统打印，
           * 主窗口的 window-open 策略直接拒绝，留在工具栏里只会点了没反应。
           * 缩放与搜索保留 —— 它们是纯前端能力。
           */
          toolbar: {
            download: false,
            print: false,
            exportHtml: false,
            theme: false,
          },
        },
        onStateChange(state) {
          if (state.error) {
            if (!errorSent) {
              errorSent = true;
              reportError(describeError(state.error));
            }
            return;
          }
          if (state.ready) markState("ready");
          if (!state.loading && !readySent) {
            readySent = true;
            post({ type: "nova:viewer-ready" });
          }
        },
      },
      {
        onError(error) {
          if (errorSent) return;
          errorSent = true;
          reportError(describeError(error));
        },
      },
    );
  } catch (error) {
    errorSent = true;
    reportError(describeError(error));
  }

  if (!errorSent) {
    // 挂载完成即通知宿主收起遮罩；解析进度由查看器自己的加载态展示
    markState("mounted");
    post({ type: "nova:viewer-mounted" });
  }
}
