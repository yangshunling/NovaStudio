/**
 * MCP 资产 IPC
 *
 * 文件库的扫描与读写都在 mcp/catalog；本层只负责选择框与打开配置文件。
 */

import { dialog, shell } from "electron";
import {
  deleteMcpServer,
  getMcpServer,
  importMcpFromPath,
  importMcpServers,
  listMcpServers,
  saveMcpServer,
} from "../../mcp/catalog";
import { getMainWindow } from "../push";
import { handle } from "../register";

export function registerMcpHandlers(): void {
  handle("mcp:list", () => listMcpServers());

  handle("mcp:create", ({ draft }) => saveMcpServer(null, draft));

  handle("mcp:update", ({ id, draft }) => saveMcpServer(id, draft));

  handle("mcp:delete", ({ id }) => deleteMcpServer(id));

  handle("mcp:import", ({ json }) => importMcpServers(json));

  handle("mcp:importFile", async () => {
    const window = getMainWindow();
    if (!window) return { ok: false, imported: [], error: "窗口未就绪" };

    const picked = await dialog.showOpenDialog(window, {
      title: "选择 MCP 配置文件",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true, imported: [] };
    }
    return importMcpFromPath(picked.filePaths[0]);
  });

  handle("mcp:reveal", async ({ id }) => {
    const asset = await getMcpServer(id);
    if (!asset) return false;
    return !(await shell.openPath(asset.path));
  });
}
