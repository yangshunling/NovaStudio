/**
 * 数字员工列表（跨页共享）
 *
 * 员工列表被 5 个资产页同时需要（MCP / 技能 / 知识库用于计算「多少员工在用」，
 * 员工页自己用于展示）。此前每个页面各拉一份、各存一份 state，重复且不一致。
 * 这里收敛成单一来源：
 *
 *   const employees = useEmployeesStore((s) => s.employees);
 *   useEffect(() => { void load(); }, [load]);   // 页面首次进入时拉一次
 *
 * 已经加载过则不重复拉取（员工增删改由员工页主动 refresh）。
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { toMessage } from "../lib/utils";
import type { DigitalEmployee } from "@shared/types";

interface EmployeesState {
  employees: DigitalEmployee[];
  loading: boolean;
  /** 加载失败信息（成功后清空） */
  error: string | null;
  /** 是否已成功加载过（避免每次进页面都重拉） */
  loaded: boolean;
  load: (force?: boolean) => Promise<void>;
  /** 就地更新单个员工（保存后同步） */
  upsert: (employee: DigitalEmployee) => void;
  remove: (id: string) => void;
}

/** 进行中的加载；重复调用复用同一个 Promise，force 请求排队补扫 */
let inFlight: Promise<void> | null = null;
let queuedForce = false;

export const useEmployeesStore = create<EmployeesState>((set, get) => ({
  employees: [],
  loading: false,
  error: null,
  loaded: false,

  load: (force = false) => {
    if (inFlight) {
      if (force) queuedForce = true;
      return inFlight;
    }
    if (get().loaded && !force) return Promise.resolve();

    const run = (async () => {
      set({ loading: true });
      try {
        const employees = await ipc.listEmployees();
        set({ employees, loaded: true, error: null });
      } catch (err) {
        set({ error: toMessage(err) });
      } finally {
        set({ loading: false });
      }
    })();

    inFlight = run.finally(() => {
      inFlight = null;
      if (queuedForce) {
        queuedForce = false;
        void get().load(true);
      }
    });
    return inFlight;
  },

  upsert: (employee) =>
    set((s) => {
      const index = s.employees.findIndex((item) => item.id === employee.id);
      if (index === -1) return { employees: [employee, ...s.employees] };
      const employees = [...s.employees];
      employees[index] = employee;
      return { employees };
    }),

  remove: (id) =>
    set((s) => ({ employees: s.employees.filter((item) => item.id !== id) })),
}));

/**
 * 统计某个资产被多少位员工启用引用。
 *
 * MCP / 技能 / 知识库三个资产页都要这个映射，抽出来避免三份相同的
 * Map 计算逻辑各自漂移。
 */
export function countUsage<E extends { enabled: boolean; assetId?: string | null }>(
  employees: DigitalEmployee[],
  pick: (employee: DigitalEmployee) => E[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const employee of employees) {
    for (const ref of pick(employee)) {
      if (ref.enabled && ref.assetId) {
        map.set(ref.assetId, (map.get(ref.assetId) ?? 0) + 1);
      }
    }
  }
  return map;
}