import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

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
    plugins: [react(), tailwindcss()],
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
        },
        output: {
          /*
           * 主包仍包含 React / assistant-ui / Markdown / Shiki，单文件过大。
           * 按依赖类别拆成可缓存的独立 chunk：首屏总字节基本不变，但
           * 解析粒度更小，后续版本升级也只需重新下载变化的 vendor 块。
           */
          manualChunks(id) {
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
