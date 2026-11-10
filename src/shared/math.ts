/** 数值夹紧：把 value 限制在 [min, max] 区间内 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
