/**
 * 工作流运行 / 节点状态的统一展示配置
 *
 * 运行详情、调试栏、运行记录、画布节点共用这一份，
 * 避免同一种状态在不同页面出现不同文案或颜色。
 */

import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  MinusCircle,
  PauseCircle,
  SkipForward,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { WorkflowNodeRunStatus, WorkflowRunStatus } from "@shared/types";

export interface WorkflowStatusMeta {
  label: string;
  /** 语义色类名（文字 / 图标） */
  className: string;
  icon: LucideIcon;
}

export const RUN_STATUS: Record<WorkflowRunStatus, WorkflowStatusMeta> = {
  running: { label: "运行中", className: "text-accent", icon: Loader2 },
  awaiting_approval: {
    label: "等待审核",
    className: "text-accent",
    icon: PauseCircle,
  },
  succeeded: {
    label: "已完成",
    className: "text-success",
    icon: CheckCircle2,
  },
  failed: { label: "失败", className: "text-error", icon: XCircle },
  canceled: { label: "已取消", className: "text-text-muted", icon: MinusCircle },
  interrupted: {
    label: "已中断",
    className: "text-error",
    icon: AlertTriangle,
  },
};

export const NODE_STATUS: Record<WorkflowNodeRunStatus, WorkflowStatusMeta> = {
  pending: { label: "待执行", className: "text-text-muted", icon: Circle },
  running: { label: "执行中", className: "text-accent", icon: Loader2 },
  awaiting_approval: {
    label: "等待审核",
    className: "text-accent",
    icon: PauseCircle,
  },
  retrying: { label: "重试中", className: "text-accent", icon: Loader2 },
  succeeded: {
    label: "成功",
    className: "text-success",
    icon: CheckCircle2,
  },
  failed: { label: "失败", className: "text-error", icon: XCircle },
  skipped: {
    label: "已跳过",
    className: "text-text-muted",
    icon: SkipForward,
  },
  canceled: {
    label: "已取消",
    className: "text-text-muted",
    icon: MinusCircle,
  },
};

export const ACTIVE_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "running",
  "awaiting_approval",
]);
