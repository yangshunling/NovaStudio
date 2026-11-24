/**
 * Office / PDF 文档预览 — 嵌入独立查看器页面
 *
 * 查看器（file-viewer）依赖 Worker + WASM，而主窗口运行在 file:// 源上，
 * Worker 脚本过不了同源检查。因此：
 * - 生产：主进程在 127.0.0.1 的随机端口上起一个静态服务（见
 *   main/viewer/server.ts），查看器页面、Worker、WASM 全部落在这个标准
 *   http 源下；地址由 preload 注入；
 * - 开发：查看器页面由 dev server 提供，资源由 Vite 中间件按同源路径服务。
 *
 * 跨源同时意味着隔离：查看器拿不到主窗口 DOM，也拿不到 preload 的 IPC。
 * 通信只走 postMessage：
 *   页面 → 宿主：nova:viewer-mounted / nova:viewer-ready / nova:viewer-error
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Spinner } from "../ui/Spinner";
import { useSkin } from "../../hooks/useTheme";
import { getViewerBaseUrl } from "../../lib/ipc";
import { previewUrl } from "../../lib/preview-url";

/**
 * 查看器挂载完成的通知最迟多久到达；超时按失败处理。
 * 开发期首帧要等 Vite 预打包 @file-viewer（十几 MB 的依赖），给更宽的窗口。
 */
const MOUNT_TIMEOUT_MS = import.meta.env.DEV ? 60_000 : 20_000;

function viewerPageUrl(): string | null {
  if (import.meta.env.DEV) {
    // 开发期由 Vite dev server 提供页面与 /file-viewer 资源（同一 HTTP 源）
    return new URL("/viewer/index.html", window.location.origin).href;
  }
  // 生产期由主进程在 127.0.0.1 的随机端口上提供（Worker 需要标准 http 源）
  const base = getViewerBaseUrl();
  return base ? `${base}/viewer/index.html` : null;
}

interface OfficeViewerProps {
  projectId: string;
  relativePath: string;
  /** 文件名：查看器据此判断扩展名与标题 */
  name: string;
  /** 点击「重新读取」时递增，用于强制重建 iframe */
  reloadKey: number;
  /** 查看器不可用时的降级内容（PDF 回落到 Chromium 内置查看器） */
  fallback: ReactNode;
}

type ViewerMessage = {
  type?: unknown;
  message?: unknown;
};

export function OfficeViewer({
  projectId,
  relativePath,
  name,
  reloadKey,
  fallback,
}: OfficeViewerProps) {
  const skin = useSkin();
  const [failed, setFailed] = useState<string | null>(null);
  /** ready 之前先盖一层遮罩，避免查看器自身加载前的白屏 */
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);
  const failedRef = useRef<string | null>(null);

  const page = viewerPageUrl();
  const src = useMemo(() => {
    if (!page) return null;
    const url = new URL(page);
    url.searchParams.set("src", previewUrl(projectId, relativePath));
    url.searchParams.set("name", name);
    url.searchParams.set("theme", skin.appearance);
    return url.href;
  }, [page, projectId, relativePath, name, skin.appearance]);

  useEffect(() => {
    mountedRef.current = false;
    failedRef.current = null;
    setMounted(false);
    setFailed(null);

    if (!src) {
      failedRef.current = "查看器服务未启动";
      setFailed(failedRef.current);
      return;
    }

    const viewerOrigin = new URL(src).origin;

    const onMessage = (event: MessageEvent) => {
      // 只认查看器源的消息：主窗口里还有别的 postMessage 来源
      if (event.origin !== viewerOrigin) return;
      const data = event.data as ViewerMessage | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") {
        return;
      }
      if (data.type === "nova:viewer-mounted") {
        mountedRef.current = true;
        setMounted(true);
        return;
      }
      if (data.type === "nova:viewer-ready") {
        mountedRef.current = true;
        setMounted(true);
        return;
      }
      if (data.type === "nova:viewer-error" && !failedRef.current) {
        const message =
          typeof data.message === "string" && data.message
            ? data.message
            : "预览组件加载失败";
        failedRef.current = message;
        setFailed(message);
      }
    };

    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => {
      if (mountedRef.current || failedRef.current) return;
      failedRef.current = "预览组件加载超时";
      setFailed(failedRef.current);
    }, MOUNT_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [src, reloadKey]);

  if (failed || !src) return <>{fallback}</>;

  return (
    <div className="relative h-full w-full bg-surface-2">
      {!mounted && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-2 text-text-muted">
          <Spinner className="h-5 w-5" />
          <span className="ui-type-note">正在解析文档</span>
        </div>
      )}
      <iframe
        // 换文件 / 重新读取时重建，确保查看器丢弃上一份文档的解析状态
        key={`${src}:${reloadKey}`}
        src={src}
        title={name}
        // iframe 与主窗口跨源，无需 sandbox 限制 Worker；脚本能力由查看器
        // 自身页面决定，它拿不到宿主 DOM 与 IPC
        className="h-full w-full border-0"
        onError={() => {
          failedRef.current = "无法加载文档查看器";
          setFailed(failedRef.current);
        }}
      />
    </div>
  );
}
