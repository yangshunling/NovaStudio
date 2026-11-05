/**
 * 技能资产 IPC
 *
 * 只做接线：选择框 / 打开目录留在本层，扫描与文件复制在 skills/catalog。
 * 技能内容以磁盘为准，因此这里没有数据库操作。
 */

import {
  deleteSkill,
  getSkillAsset,
  importSkillsFromPath,
  listSkillFiles,
  listSkills,
  readSkillFile,
  writeSkillFile,
} from "../../skills/catalog";
import { handle } from "../register";
import { pickPaths, revealPath } from "../nativeUi";

export function registerSkillHandlers(): void {
  handle("skills:list", () => listSkills());

  handle("skills:import", async ({ kind }) => {
    const picked = await pickPaths(
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
    if (!picked) return { ok: true, imported: [] };

    return importSkillsFromPath(picked[0], kind);
  });

  handle("skills:delete", ({ id }) => deleteSkill(id));

  handle("skills:listFiles", ({ id }) => listSkillFiles(id));

  handle("skills:readFile", ({ id, relativePath }) =>
    readSkillFile(id, relativePath),
  );

  handle("skills:writeFile", ({ id, relativePath, content }) =>
    writeSkillFile(id, relativePath, content),
  );

  handle("skills:reveal", async ({ id }) => {
    const asset = await getSkillAsset(id);
    if (!asset) return false;
    return revealPath(asset.path);
  });
}
