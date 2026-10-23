/**
 * 知识库运行时解析
 *
 * 知识库是数字员工的一部分：工作流执行节点前，把员工启用的知识库
 * 解析成「目录 + 文件清单」，以系统提示词的形式交给 Agent。
 *
 * 这里不复制文件、不做向量化：Agent 本身具备文件读取能力，
 * 直接引用 ~/.novastudio/knowledge 下的绝对路径即可。
 */

import { listKnowledgeBases, listKnowledgeFiles } from "./catalog";
import type { EmployeeKnowledge } from "../../shared/types";

/** 提示词里每个知识库最多列出的文件数，超出部分让 Agent 自行浏览目录 */
const MAX_PROMPT_FILES = 80;

export interface ResolvedKnowledgeBase {
  id: string;
  name: string;
  path: string;
  files: string[];
  fileCount: number;
}

export interface ResolvedKnowledge {
  /** 本次实际注入的知识库 */
  bases: ResolvedKnowledgeBase[];
  /** 追加到系统提示词的段落；没有可用知识库时为空串 */
  promptSection: string;
  warnings: string[];
}

function buildPromptSection(bases: ResolvedKnowledgeBase[]): string {
  if (bases.length === 0) return "";

  const lines: string[] = [
    "## 知识库",
    "",
    "以下是本员工可用的 Markdown 资料。任务涉及相关知识时，请先读取对应文件，",
    "引用时注明来源文件名；不要修改知识库中的文件。",
    "",
  ];

  for (const base of bases) {
    lines.push(`### ${base.name}`, `目录：${base.path}`);
    const shown = base.files.slice(0, MAX_PROMPT_FILES);
    for (const file of shown) lines.push(`- ${file}`);
    if (base.files.length > shown.length) {
      lines.push(
        `- …（共 ${base.fileCount} 个文件，其余请直接浏览上述目录）`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * 解析员工绑定的知识库。
 *
 * 已删除、没有文档的知识库会被跳过并记入 warnings，
 * 避免工作流因为员工配置过期而直接失败。
 */
export async function resolveEmployeeKnowledge(
  bindings: EmployeeKnowledge[],
): Promise<ResolvedKnowledge> {
  const enabled = bindings.filter((binding) => binding.enabled);
  if (enabled.length === 0) {
    return { bases: [], promptSection: "", warnings: [] };
  }

  const assets = await listKnowledgeBases();
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const bases: ResolvedKnowledgeBase[] = [];
  const warnings: string[] = [];

  for (const binding of enabled) {
    const asset = binding.assetId ? byId.get(binding.assetId) : undefined;
    const label = binding.name || binding.assetId || "未命名知识库";

    if (!asset) {
      warnings.push(`知识库「${label}」不存在（可能已被删除），已跳过`);
      continue;
    }

    const files = await listKnowledgeFiles(asset.id);
    if (files.length === 0) {
      warnings.push(`知识库「${asset.name}」没有 Markdown 文档，已跳过`);
      continue;
    }

    bases.push({
      id: asset.id,
      name: asset.name,
      path: asset.path,
      files,
      fileCount: asset.documentCount,
    });
  }

  return {
    bases,
    promptSection: buildPromptSection(bases),
    warnings,
  };
}
