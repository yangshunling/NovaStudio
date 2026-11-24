import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "path";
import {
  DEFAULT_SKIN_APPEARANCE,
  DEFAULT_SKIN_ID,
  DEFAULT_WINDOW_BACKGROUND,
  LIGHT_WINDOW_BACKGROUND,
} from "./src/shared/skin-default";

/**
 * 首帧主题引导注入。
 *
 * index.html 是静态文件，不能直接 import TS 常量；这里在构建期把
 * shared/skin-default.ts 的值替换进去，保证「注册表 / 首帧脚本 / 主进程
 * 窗口底色」三处不会各自漂移。
 */
function injectDefaultSkin(): Plugin {
  const replacements: Record<string, string> = {
    "%NOVA_DEFAULT_SKIN%": DEFAULT_SKIN_ID,
    "%NOVA_DEFAULT_APPEARANCE%": DEFAULT_SKIN_APPEARANCE,
    "%NOVA_DEFAULT_WINDOW_BACKGROUND%": DEFAULT_WINDOW_BACKGROUND,
    "%LIGHT_WINDOW_BACKGROUND%": LIGHT_WINDOW_BACKGROUND,
  };
  return {
    name: "nova-default-skin",
    transformIndexHtml(html) {
      return Object.entries(replacements).reduce(
        (out, [placeholder, value]) => out.replaceAll(placeholder, value),
        html,
      );
    },
  };
}

/**
 * File Viewer 运行时资源（Worker / WASM / 字体）的开发期静态服务。
 *
 * 生产环境由主进程的回环静态服务（main/viewer/server.ts）按同样规则读取 node_modules；
 * 开发期查看器页面在 dev server 源下，资源必须同源才能创建 Worker，
 * 因此这里把 `/file-viewer/*` 直接映射到两个资源包。
 */
const FILE_VIEWER_ASSET_MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
  json: "application/json; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
};

function fileViewerAssets(): Plugin {
  const standardRoot = resolve(
    __dirname,
    "node_modules/@file-viewer/assets-standard/viewer",
  );
  const pptRoot = resolve(
    __dirname,
    "node_modules/@file-viewer/assets-ppt/viewer",
  );
  const rootFor = (relativePath: string) =>
    relativePath.startsWith("vendor/ppt/") ? pptRoot : standardRoot;

  return {
    name: "nova-file-viewer-assets",
    configureServer(server) {
      server.middlewares.use("/file-viewer", (request, response, next) => {
        if (!request.url) return next();

        let relativePath: string;
        try {
          relativePath = decodeURIComponent(request.url.split("?")[0] ?? "")
            .replace(/^\/+/, "")
            .replace(/\\/g, "/");
        } catch {
          response.statusCode = 400;
          response.end("Bad Request");
          return;
        }
        if (!relativePath) return next();

        const root = rootFor(relativePath);
        const fullPath = resolve(root, relativePath);
        if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }

        void stat(fullPath)
          .then((info) => {
            if (!info.isFile()) {
              response.statusCode = 404;
              response.end("Not Found");
              return;
            }
            const extension = extname(fullPath).slice(1).toLowerCase();
            response.setHeader(
              "content-type",
              FILE_VIEWER_ASSET_MIME[extension] ??
                "application/octet-stream",
            );
            response.setHeader("content-length", String(info.size));
            response.setHeader("cache-control", "no-store");
            createReadStream(fullPath).pipe(response);
          })
          .catch(() => {
            response.statusCode = 404;
            response.end("Not Found");
          });
      });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
        output: {
          format: "es",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
        output: {
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
        "@renderer": resolve(__dirname, "src/renderer"),
      },
    },
    plugins: [react(), tailwindcss(), injectDefaultSkin(), fileViewerAssets()],
    build: {
      /*
       * electron-vite 的 renderer 预设默认 minify:false，产物是 5.2MB、
       * 8.6 万行的未压缩 JS；首屏必须先解析执行完它，React 才能挂载。
       * 压缩后体积约降到三分之一，对冷启动是纯收益（CSS 同步压缩）。
       */
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          /*
           * Office 查看器是独立的第二入口：它跑在主进程提供的回环 http 源里，
           * 不进主界面的 React 树，也不参与首屏加载。
           */
          viewer: resolve(__dirname, "src/renderer/viewer/index.html"),
        },
        output: {
          /*
           * 主包仍包含 React / assistant-ui / Markdown / Shiki，单文件过大。
           * 按依赖类别拆成可缓存的独立 chunk：首屏总字节基本不变，但
           * 解析粒度更小，后续版本升级也只需重新下载变化的 vendor 块。
           */
          manualChunks(id) {
            /*
             * Vite / Rollup 的运行时辅助模块（modulepreload polyfill、
             * commonjs 互操作）不属于任何业务包。不显式安置时，Rollup 会把
             * 它们塞进"恰好包含动态 import"的任意 chunk —— 实测被塞进了
             * file-viewer chunk，于是主界面所有懒加载 chunk 都反向静态引用
             * 这个 4.5MB 的块，Office 查看器反而被首屏加载了。
             * 单独切一个极小的 helper chunk，两个入口都只依赖它。
             */
            if (
              id.includes("vite/preload-helper") ||
              id.includes("vite/modulepreload-polyfill") ||
              id.includes("commonjsHelpers")
            ) {
              return "vite-helpers";
            }
            if (!id.includes("node_modules")) return undefined;
            /*
             * 不要单独切出 markdown chunk。
             *
             * react-markdown 的依赖图（unified / hast / unist / vfile …）不是闭合的：
             * 按包名匹配只能切走一部分，剩下的传递依赖落在 vendor。只要 vendor
             * 里的包反过来 import 了被切走的包（例如 vfile → unist-util-stringify-position），
             * 就会形成 vendor → markdown → vendor 的循环 chunk。
             *
             * Rollup 无法为循环 chunk 保证顶层语句的执行顺序，压缩后表现为
             * `Cannot access 'X' before initialization` —— 渲染进程在入口就抛错，
             * 页面只剩窗口底色（深色皮肤下就是黑屏）。0.3.0 首次发布即因此无法启动。
             */
            /*
             * Office 查看器及其依赖只被 viewer 入口引用。
             * 不单独切走的话它们会落进 vendor，主界面首屏也得为这几 MB 买单；
             * 切到独立 chunk 后只有打开 Office / PDF 预览时才会加载。
             *
             * @floating-ui 与主界面的 assistant-ui 共用，留在 vendor，
             * 否则主入口会反向依赖整个 file-viewer chunk。
             */
            if (
              id.includes("@file-viewer/") ||
              id.includes("/pdf-lib/") ||
              id.includes("/dompurify/") ||
              id.includes("/jszip/") ||
              id.includes("/pako/") ||
              id.includes("/e-virt-table/") ||
              id.includes("/styled-exceljs/") ||
              id.includes("/tinycolor2/") ||
              id.includes("/utif/") ||
              id.includes("/@xmldom/") ||
              id.includes("/dingbat-to-unicode/") ||
              id.includes("/@fontsource")
            ) {
              return "file-viewer";
            }
            if (id.includes("@assistant-ui")) return "assistant-ui";
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("scheduler")
            ) {
              return "react";
            }
            if (id.includes("shiki") || id.includes("@shikijs")) {
              return "shiki";
            }
            // xterm 只在打开终端标签时需要，不能混进首屏 vendor
            if (id.includes("@xterm")) return "xterm";
            if (id.includes("lucide-react")) return "icons";
            if (id.includes("zustand")) return "state";
            return "vendor";
          },
        },
      },
    },
  },
});
