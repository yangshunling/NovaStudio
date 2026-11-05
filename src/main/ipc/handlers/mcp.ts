/**
 * MCP 资产 IPC
 *
 * 文件库的扫描与读写都在 mcp/catalog；本层只负责选择框与打开配置文件。
 */

import {
  deleteMcpServer,
  getMcpServer,
  importMcpFromPath,
  importMcpServers,
  listMcpServers,
  saveMcpDefinition,
  saveMcpServer,
} from "../../mcp/catalog";
import { handle } from "../register";
import { pickPaths, revealPath } from "../nativeUi";

export function registerMcpHandlers(): void {
  handle("mcp:list", () => listMcpServers());

  handle("mcp:create", ({ draft }) => saveMcpServer(null, draft));

  handle("mcp:update", ({ id, draft }) => saveMcpServer(id, draft));

  handle("mcp:saveDefinition", ({ id, name, definition }) =>
    saveMcpDefinition(id, name, definition),
  );

  handle("mcp:delete", ({ id }) => deleteMcpServer(id));

  handle("mcp:import", ({ json }) => importMcpServers(json));

  handle("mcp:importFile", async () => {
    const picked = await pickPaths({
      title: "选择 MCP 配置文件",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return { ok: true, imported: [] };
    return importMcpFromPath(picked[0]);
  });

  handle("mcp:reveal", async ({ id }) => {
    const asset = await getMcpServer(id);
    if (!asset) return false;
    return revealPath(asset.path);
  });
}
