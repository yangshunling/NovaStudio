/**
 * 数字员工 → 可写草稿
 *
 * 员工卡片的启用开关与编辑抽屉的保存都要把整份员工转成草稿再写库，
 * 映射收敛在这里，避免两处各自拼字段时漏字段（漏掉绑定资产会被覆盖为空）。
 */

import type { DigitalEmployee, DigitalEmployeeDraft } from "@shared/types";

export function toEmployeeDraft(
  employee: DigitalEmployee,
): DigitalEmployeeDraft {
  return {
    name: employee.name,
    role: employee.role,
    description: employee.description,
    avatar: employee.avatar,
    systemPrompt: employee.systemPrompt,
    mcpServers: employee.mcpServers,
    skills: employee.skills,
    knowledgeBases: employee.knowledgeBases ?? [],
    enabled: employee.enabled,
  };
}
