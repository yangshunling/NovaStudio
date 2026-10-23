/**
 * 技能资产 IPC
 *
 * 只做接线：选择框 / 打开目录留在本层，扫描与文件复制在 skills/catalog。
 * 技能内容以磁盘为准，因此这里没有数据库操作。
 */

import { dialog, shell } from "electron";
import {
  deleteSkill,
  getSkillAsset,
  getSkillDocument,
  importSkillsFromPath,
  listSkills,
  saveSkillDocument,
} from "../../skills/catalog";
import { getMainWindow } from "../push";
import { handle } from "../register";

export function registerSkillHandlers(): void {
  handle("skills:list", () => listSkills());

  handle("skills:import", async ({ kind }) => {
    const window = getMainWindow();
    if (!window) return { ok: false, imported: [], error: "窗口未就绪" };

    const picked = await dialog.showOpenDialog(
      window,
      kind === "directory"
        ? {
            title: "选择技能文件夹（包含 SKILL.md）",
            properties: ["openDirectory"],
          }
        : {
            title: "选择 SKILL.md 文件",
            properties: ["openFile"],
            filters: [{ name: "Markdown", extensions: ["md"] }],
          },
    );

    // 用户取消不是错误：返回空结果，UI 侧不会提示
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true, imported: [] };
    }

    return importSkillsFromPath(picked.filePaths[0], kind);
  });

  handle("skills:delete", ({ id }) => deleteSkill(id));

  handle("skills:getDocument", ({ id }) => getSkillDocument(id));

  handle("skills:saveDocument", ({ id, content }) =>
    saveSkillDocument(id, content),
  );

  handle("skills:reveal", async ({ id }) => {
    const asset = await getSkillAsset(id);
    if (!asset) return false;
    return !(await shell.openPath(asset.path));
  });
}
