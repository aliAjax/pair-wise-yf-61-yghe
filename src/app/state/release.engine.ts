import type {
  GatewayState,
  GatewayTask,
  InstallOutcome,
  ReleaseBatch,
  ReleaseWave,
  ReconcileEntry,
} from './release.models';

export const WAVE_COUNT = 2;
/** 波次内所有网关派发完成后，再等多少个 tick 收结果 */
export const WAVE_GRACE_TICKS = 8;

export interface BatchStats {
  /** 本批实际纳入发布的网关总数（含离线） */
  total: number;
  waiting: number;
  offline: number;
  dispatched: number;
  retryPending: number;
  unverified: number;
  succeeded: number;
  failed: number;
  /** 已确认最终结果的网关数，失败率只以它为分母 */
  confirmed: number;
  /** 失败率：失败 / 已确认，离线与待核对都不进分母 */
  failureRate: number;
  /** 整体进度：已落定（成功/失败/待核对/待重报）/ 总数 */
  settled: number;
  progress: number;
  activeWave: number | null;
}

export function createPlan(target: number, offlineCount: number, now: string): { waves: ReleaseWave[]; gateways: GatewayTask[] } {
  const safeTarget = Math.max(0, Math.floor(target));
  const firstSize = Math.ceil(safeTarget / WAVE_COUNT);
  const waves: ReleaseWave[] = Array.from({ length: WAVE_COUNT }, (_, index) => {
    const size = index === 0 ? firstSize : safeTarget - firstSize;
    return { index, status: 'pending', total: Math.max(0, size) };
  });
  const gateways: GatewayTask[] = [];
  let offlineLeft = Math.min(offlineCount, safeTarget);
  for (let index = 0; index < safeTarget; index++) {
    const waveIndex = index < firstSize ? 0 : 1;
    const offline = offlineLeft > 0;
    if (offline) offlineLeft -= 1;
    gateways.push({
      id: `gw-${index + 1}`,
      waveIndex,
      state: offline ? 'offline' : 'waiting',
      retryAttempts: 0,
    });
  }
  void now;
  return { waves, gateways };
}

const TERMINAL_BATCH: ReadonlyArray<ReleaseBatch['status']> = ['completed', 'rolled_back'];

export function isBatchFinished(batch: ReleaseBatch): boolean {
  return TERMINAL_BATCH.includes(batch.status);
}

const SETTLED: ReadonlySet<GatewayState> = new Set(['succeeded', 'failed', 'unverified', 'retry_pending']);

export function tally(batch: ReleaseBatch): BatchStats {
  const s = { waiting: 0, offline: 0, dispatched: 0, retryPending: 0, unverified: 0, succeeded: 0, failed: 0 };
  for (const gw of batch.gateways) {
    s[gw.state === 'retry_pending' ? 'retryPending' : gw.state] += 1;
  }
  const total = batch.gateways.length;
  const confirmed = s.succeeded + s.failed;
  const settled = s.succeeded + s.failed + s.unverified + s.retryPending;
  return {
    total,
    ...s,
    confirmed,
    failureRate: confirmed ? (s.failed / confirmed) * 100 : 0,
    settled,
    progress: total ? Math.round((settled / total) * 100) : 0,
    activeWave: batch.activeWave,
  };
}

export type ReportEffect = 'new' | 'duplicate' | 'reconcile';

/**
 * 合并一条安装结果：
 * - 同一 resultId 的重传直接丢弃，只计一次；
 * - 批次进行中，回网/迟到但已转待核对的结果照样合并，失败率随之变化；
 * - 批次已结束（完成/回滚），结果只进对账，状态不回翻。
 */
export function applyReport(
  batch: ReleaseBatch,
  gatewayId: string,
  resultId: string,
  outcome: InstallOutcome,
  now: string
): { batch: ReleaseBatch; effect: ReportEffect } {
  if (batch.resultIds.includes(resultId)) {
    return { batch, effect: 'duplicate' };
  }
  const gateway = batch.gateways.find((item) => item.id === gatewayId);
  if (!gateway) {
    return { batch, effect: 'duplicate' };
  }
  // 已有确认终态的网关：新的 resultId 属于冲突报文，任何阶段都忽略
  if (gateway.state === 'succeeded' || gateway.state === 'failed') {
    return { batch, effect: 'duplicate' };
  }

  if (isBatchFinished(batch)) {
    // 未确认（待核对/离线/在途/待重报）的网关此时才有结果可对账
    const entry: ReconcileEntry = {
      resultId,
      gatewayId,
      waveIndex: gateway.waveIndex,
      outcome,
      receivedAt: now,
      note: '批次结束后到达，仅登记对账，不改变发布状态',
    };
    return {
      batch: {
        ...batch,
        resultIds: [...batch.resultIds, resultId],
        reconcile: [entry, ...batch.reconcile],
        // 网关级结果按实际落账（参与对账统计），批次状态不翻回发布中
        gateways: batch.gateways.map((item) =>
          item.id === gatewayId
            ? { ...item, state: outcome as GatewayState, resultId: item.resultId ?? resultId, reconciledAt: now, pendingOutcome: undefined, dueTick: undefined }
            : item
        ),
        updatedAt: now,
      },
      effect: 'reconcile',
    };
  }

  const gateways = batch.gateways.map((item) =>
    item.id === gatewayId
      ? { ...item, state: outcome as GatewayState, resultId, reportedAt: now, pendingOutcome: undefined, dueTick: undefined, reconciledAt: undefined }
      : item
  );
  return {
    batch: { ...batch, gateways, resultIds: [...batch.resultIds, resultId], updatedAt: now },
    effect: 'new',
  };
}

/** 上报失败：保留结果内容，置为待重试，未确认前不计入失败率分母 */
export function markReportPending(batch: ReleaseBatch, gatewayId: string, outcome: InstallOutcome, now: string): ReleaseBatch {
  return {
    ...batch,
    updatedAt: now,
    gateways: batch.gateways.map((gw) =>
      gw.id === gatewayId && gw.state === 'dispatched'
        ? { ...gw, state: 'retry_pending', pendingOutcome: outcome, retryAttempts: gw.retryAttempts + 1 }
        : gw
    ),
  };
}

/** 波次关闭：仍未回报/仍离线的网关一律留成待核对 */
export function finalizeWave(batch: ReleaseBatch, waveIndex: number, now: string): ReleaseBatch {
  const gateways = batch.gateways.map((gw) => {
    if (gw.waveIndex !== waveIndex) return gw;
    if (gw.state === 'succeeded' || gw.state === 'failed' || gw.state === 'unverified' || gw.state === 'retry_pending') return gw;
    return { ...gw, state: 'unverified' as GatewayState, dueTick: undefined };
  });
  const waves = batch.waves.map((wave) => (wave.index === waveIndex ? { ...wave, status: 'finalized' as const, finalizedAt: now } : wave));
  return { ...batch, gateways, waves };
}

export function startWave(batch: ReleaseBatch, waveIndex: number, now: string): ReleaseBatch {
  return {
    ...batch,
    activeWave: waveIndex,
    waves: batch.waves.map((wave) =>
      wave.index === waveIndex && wave.status === 'pending' ? { ...wave, status: 'running' as const, startedAt: now } : wave
    ),
  };
}

/** 旧版（v1，无 version 字段）localStorage 数据升级到 v2 */
export function migrateBatch(old: Record<string, unknown>, groupOffline: number, now: string): ReleaseBatch {
  const id = String(old['id'] ?? crypto.randomUUID());
  const groupCount = Number(old['_groupCount'] ?? 0);
  const planned = Math.max(1, Math.round((groupCount * Number(old['rolloutPercent'] ?? 0)) / 100));
  const { waves, gateways } = createPlan(planned, groupOffline, now);
  const status = String(old['status'] ?? 'draft') as ReleaseBatch['status'];

  const downloaded = Math.min(planned, Number(old['downloaded'] ?? 0));
  const failed = Math.min(downloaded, Number(old['failed'] ?? 0));
  const succeeded = downloaded - failed;

  const resultIds: string[] = [];
  let migrated = gateways;
  if (status === 'completed' || status === 'rolled_back') {
    migrated = gateways.map((gw, index) => {
      const isFailed = index < failed;
      const isDone = index < downloaded;
      if (!isDone) return { ...gw, state: 'unverified' as GatewayState };
      const resultId = `mig-${id}-${gw.id}`;
      resultIds.push(resultId);
      return { ...gw, state: (isFailed ? 'failed' : 'succeeded') as GatewayState, resultId, reportedAt: now };
    });
  } else if (downloaded > 0) {
    // 发布中/暂停：把旧计数摊到前波，剩余保持在途/离线
    migrated = gateways.map((gw, index) => {
      if (index < failed) {
        const resultId = `mig-${id}-${gw.id}`;
        resultIds.push(resultId);
        return { ...gw, state: 'failed' as GatewayState, resultId, reportedAt: now };
      }
      if (index < downloaded) {
        const resultId = `mig-${id}-${gw.id}`;
        resultIds.push(resultId);
        return { ...gw, state: 'succeeded' as GatewayState, resultId, reportedAt: now };
      }
      return gw;
    });
  }

  const finished = status === 'completed' || status === 'rolled_back';
  const finalWaves = finished
    ? waves.map((wave) => ({ ...wave, status: 'finalized' as const, startedAt: now, finalizedAt: now }))
    : status === 'running' || status === 'paused'
      ? waves.map((wave, index) => (index === 0 && wave.total > 0 ? { ...wave, status: 'running' as const, startedAt: now } : wave))
      : waves;

  return {
    id,
    name: String(old['name'] ?? '未命名批次'),
    firmware: String(old['firmware'] ?? ''),
    rollbackVersion: String(old['rollbackVersion'] ?? ''),
    groupId: String(old['groupId'] ?? ''),
    rolloutPercent: Number(old['rolloutPercent'] ?? 0),
    failureThreshold: Number(old['failureThreshold'] ?? 0),
    status,
    updatedAt: String(old['updatedAt'] ?? now),
    waves: finalWaves,
    gateways: migrated,
    activeWave: status === 'running' ? 0 : finished ? null : status === 'paused' ? 0 : null,
    tick: 0,
    pauseReason: status === 'paused' ? '旧版本暂停状态，升级后保留；继续前按最新结果复核失败率' : undefined,
    reconcile: [],
    resultIds,
    progress: Number(old['progress'] ?? 0),
    downloaded: downloaded,
    failed: failed,
  };
}
