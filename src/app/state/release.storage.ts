import type { ActionReducer, MetaReducer } from '@ngrx/store';
import type { ReleaseBatch, ReleaseState } from './release.models';

export interface AppState {
  release: ReleaseState;
}
import { migrateBatch } from './release.engine';

export const STORAGE_KEY = 'firmware-release-v2';
const LEGACY_KEY = 'firmware-release-v1';

function normalizeBatch(batch: ReleaseBatch): ReleaseBatch {
  return {
    ...batch,
    waves: batch.waves ?? [],
    gateways: batch.gateways ?? [],
    reconcile: batch.reconcile ?? [],
    resultIds: batch.resultIds ?? [],
    tick: batch.tick ?? 0,
    activeWave: batch.activeWave ?? null,
  };
}

function fromV2(raw: unknown): ReleaseState | null {
  const data = raw as Partial<ReleaseState> | null;
  if (!data || !Array.isArray(data.batches)) return null;
  return {
    version: 2,
    groups: Array.isArray(data.groups) ? data.groups : [],
    audits: Array.isArray(data.audits) ? data.audits : [],
    batches: data.batches.map((batch) => normalizeBatch(batch)),
  };
}

/** 读取旧版（v1）localStorage 数据并升级：扁平计数展开为波次 + 逐网关结果 */
function fromV1(raw: string, fallback: ReleaseState): ReleaseState {
  try {
    const old = JSON.parse(raw) as { groups?: ReleaseState['groups']; batches?: Array<Record<string, unknown>>; audits?: ReleaseState['audits'] } | null;
    if (!old || !Array.isArray(old.batches)) return fallback;
    const now = new Date().toISOString();
    const groups = old.groups ?? fallback.groups;
    const groupCount = new Map(groups.map((group) => [group.id, group.count]));
    const offlineOf = new Map(groups.map((group) => [group.id, group.offlineGateways]));
    const batches = old.batches.map((batch) =>
      migrateBatch(
        { ...batch, _groupCount: groupCount.get(String(batch['groupId'])) ?? 0 },
        offlineOf.get(String(batch['groupId'])) ?? 0,
        now
      )
    );
    return {
      version: 2,
      groups,
      batches,
      audits: Array.isArray(old.audits) ? old.audits : fallback.audits,
    };
  } catch {
    return fallback;
  }
}

export function loadInitialState(fallback: ReleaseState): ReleaseState {
  if (typeof localStorage === 'undefined') return fallback;
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  const v2 = fromV2(raw);
  if (v2) return v2;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    const migrated = fromV1(legacy, fallback);
    if (migrated !== fallback) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated;
  }
  return fallback;
}

/** 状态变化后持久化；localStorage 写失败不能影响发布流程 */
export const persistenceMetaReducer: MetaReducer<AppState> = (reducer: ActionReducer<AppState>) => (state, action) => {
  const next = reducer(state, action);
  if (typeof localStorage !== 'undefined' && next !== state && next.release) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next.release));
    } catch {
      /* 忽略配额/隐私模式写入失败 */
    }
  }
  return next;
};
