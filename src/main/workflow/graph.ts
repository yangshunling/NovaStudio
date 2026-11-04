/**
 * 工作流图校验（兼容导出）
 *
 * 实现已移到 shared：渲染进程的编辑器需要在保存/调试前用同一套规则
 * 实时展示问题，避免“主进程校验、用户只能看 toast”的割裂。
 */

export {
  GraphValidationError,
  validateGraph,
  type ValidatedGraph,
} from "../../shared/workflow-graph";
