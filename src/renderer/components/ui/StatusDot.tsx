/**
 * 状态圆点
 *
 * 统一会话/任务的状态指示圆点。
 * status: "active" | "inactive" | "streaming" | "success" | "error"
 */

interface StatusDotProps {
  status: "active" | "inactive" | "streaming" | "success" | "error";
  className?: string;
}

const statusClasses: Record<StatusDotProps["status"], string> = {
  active: "bg-accent",
  inactive: "bg-text-muted/30",
  streaming: "bg-accent animate-pulse",
  success: "bg-success",
  error: "bg-error",
};

export function StatusDot({ status, className = "" }: StatusDotProps) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${statusClasses[status]} ${className}`}
    />
  );
}