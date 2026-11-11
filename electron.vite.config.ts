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
      },
    },
  },
});
