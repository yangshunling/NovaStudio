/**
 * 列表关键字筛选
 *
 * 资产页共用：query 为空时原样返回；候选字段里的空值自动跳过。
 */

import { useMemo, useRef } from "react";

export function useFilteredList<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
): T[] {
  // fields 通常是内联箭头函数；用 ref 保存，避免每次渲染都让 memo 失效
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  return useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items as T[];
    return items.filter((item) =>
      fieldsRef.current(item).some((value) =>
        value ? value.toLowerCase().includes(keyword) : false,
      ),
    );
  }, [items, query]);
}
