/**
 * 知识库 IPC
 *
 * 文件库的扫描 / 复制 / 索引都在 knowledge/catalog；本层只负责选择框、
 * 打开目录，以及把薄操作接到契约上。
 */

import { dialog, shell } from "electron";
import {
  createKnowledgeBase,
  createKnowledgeFolder,
  deleteKnowledgeBase,
  deleteKnowledgeDocuments,
  getKnowledgeBase,
  importKnowledgeFiles,
  listKnowledgeBases,
  listKnowledgeDocuments,
  readKnowledgeDocument,
  resolveDocumentPath,
  searchKnowledge,
  updateKnowledgeBase,
} from "../../knowledge/catalog";
import * as db from "../../db/sqlite";
import { getMainWindow } from "../push";
import { handle } from "../register";

export function registerKnowledgeHandlers(): void {
  handle("knowledge:list", () => listKnowledgeBases());

  handle("knowledge:create", ({ name, description }) =>
    createKnowledgeBase(name, description),
  );

  handle("knowledge:update", ({ id, name, description }) =>
    updateKnowledgeBase(id, name, description),
  );

  /**
   * 删除知识库前先确认没有数字员工绑着它。
   *
   * 否则这些员工在后续运行里会「悄悄失去资料」：runtime 只往日志里写一行
   * warning 就继续执行，输出质量下降但界面上看不出任何异常。
   */
  handle("knowledge:delete", async ({ id }) => {
    const asset = await getKnowledgeBase(id);
    if (!asset) return false;

    const users = db
      .listDigitalEmployees()
      .filter((employee) =>
        employee.knowledgeBases.some(
          (ref) => ref.assetId === asset.id || ref.assetId === id,
        ),
      );
    if (users.length > 0) {
      const names = users.slice(0, 3).map((item) => item.name).join("、");
      const rest = users.length > 3 ? ` 等 ${users.length} 个` : "";
      throw new Error(
        `无法删除：数字员工「${names}」${rest}正在使用该知识库，请先解除绑定`,
      );
    }

    return deleteKnowledgeBase(id);
  });

  handle("knowledge:listDocuments", ({ id, subPath }) =>
    listKnowledgeDocuments(id, subPath ?? ""),
  );

  handle("knowledge:createFolder", ({ id, parentPath, name }) =>
    createKnowledgeFolder(id, parentPath, name),
  );

  handle("knowledge:upload", async ({ id, parentPath }) => {
    const window = getMainWindow();
    if (!window) {
      return {
        ok: false,
        uploaded: [],
        warnings: [],
        error: "窗口未就绪",
      };
    }

    const picked = await dialog.showOpenDialog(window, {
      title: "选择 Markdown 文档（可多选）",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true, uploaded: [], warnings: [] };
    }

    return importKnowledgeFiles(id, parentPath, picked.filePaths);
  });

  handle("knowledge:deleteDocuments", ({ id, paths }) =>
    deleteKnowledgeDocuments(id, paths),
  );

  handle("knowledge:search", ({ query, kbId }) =>
    searchKnowledge(query, kbId),
  );

  handle("knowledge:readDocument", ({ id, relativePath }) =>
    readKnowledgeDocument(id, relativePath),
  );

  handle("knowledge:reveal", async ({ id }) => {
    const asset = await getKnowledgeBase(id);
    if (!asset) return false;
    return !(await shell.openPath(asset.path));
  });

  handle("knowledge:openDocument", async ({ id, relativePath }) => {
    const target = await resolveDocumentPath(id, relativePath);
    if (!target) return false;
    return !(await shell.openPath(target));
  });
}
