// 组合适配器：每个原语按配置静态路由到一种实现（cli/http/fake），从不在运行时根据成败改用另一种。
// 'unavailable' 或缺失的实现 → CAPABILITY_UNVERIFIED。见 docs/ARCHITECTURE.md §5.1。

import type { SurgeAdapter } from '../ports.js';
import { SURGE_PRIMITIVES, capabilityUnverified, type MechanismMap, type SurgePrimitive } from './primitives.js';

export interface CompositeParts {
  cli?: SurgeAdapter;
  http?: SurgeAdapter;
  fake?: SurgeAdapter;
  mechanism: MechanismMap;
}

export function createCompositeAdapter(parts: CompositeParts): SurgeAdapter {
  const mechanism = { ...parts.mechanism };
  const route = (p: SurgePrimitive): SurgeAdapter => {
    const m = mechanism[p];
    const target = m === 'cli' ? parts.cli : m === 'http' ? parts.http : m === 'fake' ? parts.fake : undefined;
    if (!target) throw capabilityUnverified(p);
    return target;
  };
  const adapter = { mechanism: () => ({ ...mechanism }) } as Record<string, unknown>;
  for (const p of SURGE_PRIMITIVES) {
    adapter[p] = async (...args: unknown[]) => {
      const target = route(p);
      return (target[p] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
    };
  }
  return adapter as unknown as SurgeAdapter;
}
