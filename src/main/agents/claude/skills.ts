/**
 * Claude 技能物化
 *
 * 把员工绑定的技能复制进本次运行的隔离配置目录（CLAUDE_CONFIG_DIR/skills）。
 * 这是 Claude 专属的运行时适配，不属于技能资产目录本身；catalog 只负责扫描、
 * 导入与文档读写。
 */

import { existsSync } from "fs";
import { cp, mkdir, stat } from "fs/promises";
import { isAbsolute, join } from "path";
import { listSkills } from "../../skills/catalog";
import { copyFilter } from "../../utils/fs";
import type { EmployeeSkill } from "../../../shared/types";

function safeDirName(raw: string): string {
  return (
    raw
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

/**
 * 把员工启用的技能复制进该次运行的隔离配置目录。
 *
 * - 主库 / 只读来源都从扫描结果解析，运行时不再依赖员工里存的旧路径
 * - 旧版员工数据（assetId 为空）仍按 workspace 相对路径兼容
 * - 同名技能追加序号并记入告警，避免 Agent 侧互相覆盖
 *
 * @returns 实际安装到配置目录的技能目录名
 */
export async function materializeEmployeeSkills(input: {
  configDir: string;
  workspacePath: string;
  skills: EmployeeSkill[];
  warnings: string[];
}): Promise<string[]> {
  const enabled = input.skills.filter((skill) => skill.enabled);
  if (enabled.length === 0) return [];

  const catalog = await listSkills();
  const byId = new Map(catalog.map((asset) => [asset.id, asset]));
  const skillsRoot = join(input.configDir, "skills");
  await mkdir(skillsRoot, { recursive: true });

  const usedNames = new Set<string>();
  const installed: string[] = [];

  for (const skill of enabled) {
    const asset = skill.assetId ? byId.get(skill.assetId) : undefined;
    const label = skill.name || asset?.name || skill.assetId || "未命名技能";
    let sourcePath: string | null = null;

    if (asset) {
      if (!existsSync(join(asset.path, "SKILL.md"))) {
        input.warnings.push(`技能「${label}」缺少 SKILL.md，已跳过`);
        continue;
      }
      if (!asset.valid) {
        input.warnings.push(
          `技能「${label}」未通过校验（${asset.problems.join("；")}），仍尝试注入`,
        );
      }
      sourcePath = asset.path;
    } else if (skill.source?.trim()) {
      // 旧版路径技能：保持原有语义（绝对路径或相对工作区）
      const resolved = isAbsolute(skill.source)
        ? skill.source
        : join(input.workspacePath, skill.source);
      try {
        await stat(resolved);
        sourcePath = resolved;
      } catch {
        input.warnings.push(`技能「${label}」的来源不存在：${skill.source}`);
        continue;
      }
    } else {
      input.warnings.push(
        `技能「${label}」找不到对应资产（可能已被删除），已跳过`,
      );
      continue;
    }

    // 用目录名而不是 frontmatter name：保持与源目录一致，Claude 侧更容易定位
    const base = safeDirName(asset?.slug || label);
    let dirName = base;
    let index = 2;
    while (usedNames.has(dirName.toLowerCase())) {
      dirName = `${base}-${index}`;
      index += 1;
    }
    if (dirName !== base) {
      input.warnings.push(
        `技能「${label}」与已加载技能重名，已安装为 ${dirName}/`,
      );
    }
    usedNames.add(dirName.toLowerCase());

    const target = join(skillsRoot, dirName);
    try {
      const info = await stat(sourcePath);
      if (info.isDirectory()) {
        await cp(sourcePath, target, { recursive: true, filter: copyFilter });
      } else {
        // 单个文件视为 SKILL.md
        await mkdir(target, { recursive: true });
        await cp(sourcePath, join(target, "SKILL.md"));
      }
      installed.push(dirName);
    } catch (err) {
      input.warnings.push(
        `技能「${label}」复制失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return installed;
}
