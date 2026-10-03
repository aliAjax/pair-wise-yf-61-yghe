import type { DeviceGroup, GatewayInstall, GatewayResultStatus, ReleaseBatch, ReleaseState } from './release.models';

export const STORAGE_KEY = 'firmware-release-v1';
export const WAVE_COUNT = 2;
/** 失败率自动暂停的最小样本数，避免早期个别上报导致误暂停 */
export const MIN_SAMPLE = 10;
/** 模拟：目标网关中约 8% 为离线/晚回，回网后合并结果 */
const OFFLINE_RATIO = 8;
/** 在线网关每 tick 上报概率 */
const ONLINE_REPORT_CHANCE = 0.35;
/** 离线网关每 tick 回网概率 */
const OFFLINE_RETURN_CHANCE = 0.12;
/** 失败待重试网关每 tick 重试概率 */
const RETRY_CHANCE = 0.2;
/** 在线上报成功率 / 离线回网成功率 */
const ONLINE_SUCCESS = 0.94;
const OFFLINE_SUCCESS = 0.82;
/** 重试成功率 */
const RETRY_SUCCESS = 0.65;

export function targetCount(group: DeviceGroup | undefined, rolloutPercent: number): number {
  if (!group) return 0;
  return Math.round((group.count * rolloutPercent) / 100);
}

function hashSeed(...parts: Array<string | number>): number {
  // FNV-1a，分布比多项式哈希更均匀，避免同分组网关在线状态扎堆
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (const ch of s) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h;
}

function isOnline(groupId: string, gatewayIndex: number): boolean {
  return hashSeed(groupId, gatewayIndex) % 100 >= OFFLINE_RATIO;
}

/** 按批次目标网关数拆成前后 WAVE_COUNT 波，生成网关级安装结果 */
export function buildGateways(batch: ReleaseBatch, group: DeviceGroup | undefined): GatewayInstall[] {
  const target = targetCount(group, batch.rolloutPercent);
  const waveSize = Math.ceil(target / WAVE_COUNT);
  const gateways: GatewayInstall[] = [];
  for (let i = 0; i < target; i++) {
    const wave = Math.min(WAVE_COUNT - 1, Math.floor(i / waveSize));
    gateways.push({
      gatewayId: `${batch.groupId}-gw-${i}`,
      wave,
      online: isOnline(batch.groupId, i),
      status: 'pending',
      attempts: 0,
      resultKey: `${batch.groupId}-gw-${i}|${batch.firmware}|install`,
      reportedAt: null,
      lastReportedAt: null,
      reconciled: false
    });
  }
  return gateways;
}

export interface BatchStats {
  downloaded: number;
  failed: number;
  pendingVerification: number;
  pendingOffline: number;
  /** 已有最终结果的网关数（succeeded + failed），失败率分母 */
  reported: number;
  failureRate: number;
  progress: number;
}

/** 由各网关状态聚合统计。同一条安装结果重传只算一次，统计始终幂等。 */
export function recomputeStats(batch: ReleaseBatch, group: DeviceGroup | undefined): BatchStats {
  const target = targetCount(group, batch.rolloutPercent);
  let downloaded = 0;
  let failed = 0;
  let pendingVerification = 0;
  let pendingOffline = 0;
  for (const gw of batch.gateways) {
    switch (gw.status) {
      case 'succeeded':
        downloaded++;
        break;
      case 'failed':
        failed++;
        break;
      case 'pending_verification':
        pendingVerification++;
        break;
      case 'pending':
        pendingOffline++;
        break;
    }
  }
  const reported = downloaded + failed;
  // 失败率分母只含有结果的网关，离线待回来不计入
  const failureRate = reported ? (failed / reported) * 100 : 0;
  const progress = target
    ? Math.min(100, Math.round(((downloaded + failed + pendingVerification) / target) * 100))
    : 0;
  return { downloaded, failed, pendingVerification, pendingOffline, reported, failureRate, progress };
}

/**
 * 波次结算：该波网关是否都有了最终结果。
 * 在线网关必须 succeeded/failed；离线待回来（pending）不阻塞下一波，回网后合并。
 */
export function waveSettled(batch: ReleaseBatch, wave: number): boolean {
  return batch.gateways
    .filter((gw) => gw.wave === wave)
    .every((gw) => {
      if (gw.status === 'succeeded' || gw.status === 'failed') return true;
      if (!gw.online && gw.status === 'pending') return true;
      return false;
    });
}

function withStats(batch: ReleaseBatch, group: DeviceGroup | undefined, extra: Partial<ReleaseBatch>): ReleaseBatch {
  const stats = recomputeStats(batch, group);
  return { ...batch, ...stats, ...extra };
}

/** 单个遥测 tick 的模拟步进，返回新批次与产生的审计事件 */
export function simulateTick(batch: ReleaseBatch, group: DeviceGroup | undefined): { batch: ReleaseBatch; events: string[] } {
  const events: string[] = [];
  const now = new Date().toISOString();
  let gateways = batch.gateways.map((gw) => ({ ...gw }));
  let activeWave = batch.activeWave;
  let status = batch.status;
  let pausedReason = batch.pausedReason;

  // 已结束批次：迟到结果只进对账，不再把状态翻回发布中
  if (status === 'completed' || status === 'rolled_back') {
    gateways = gateways.map((gw) => {
      if (gw.status !== 'pending_verification') return gw;
      if (Math.random() < OFFLINE_RETURN_CHANCE) {
        const ok = Math.random() < OFFLINE_SUCCESS;
        events.push(`批次 ${batch.id} 有迟到的安装结果回网（网关 ${gw.gatewayId}），已进入对账，发布状态不变`);
        return {
          ...gw,
          status: ok ? ('succeeded' as const) : ('failed' as const),
          reconciled: true,
          reportedAt: gw.reportedAt ?? now,
          lastReportedAt: now
        };
      }
      return gw;
    });
    return { batch: withStats({ ...batch, gateways }, group, { status, pausedReason }), events };
  }

  if (status !== 'running' && status !== 'paused') return { batch, events };
  const wasRunning = status === 'running';

  // 首次进入发布：拆分波次并初始化网关结果
  if (wasRunning && activeWave === -1) {
    if (gateways.length === 0) gateways = buildGateways(batch, group);
    activeWave = 0;
    events.push(`批次 ${batch.id} 开始发布，共 ${gateways.length} 台网关，分 ${WAVE_COUNT} 波，当前第 1 波`);
  }

  // 处理已释放波次的网关上报 / 失败重试（暂停时也合并迟到结果，让失败率可回升）
  gateways = gateways.map((gw) => {
    if (gw.wave > activeWave) return gw; // 未释放的波次不上报
    if (gw.status === 'succeeded' || gw.status === 'pending_verification') return gw;
    if (gw.status === 'failed') {
      // 上报失败后保留待重试：重试成功转 succeeded，仍失败保留 failed
      if (Math.random() < RETRY_CHANCE) {
        const ok = Math.random() < RETRY_SUCCESS;
        return { ...gw, status: ok ? ('succeeded' as const) : ('failed' as const), attempts: gw.attempts + 1, lastReportedAt: now };
      }
      return gw;
    }
    // pending：在线网关按时上报，离线网关回网后合并结果
    const chance = gw.online ? ONLINE_REPORT_CHANCE : OFFLINE_RETURN_CHANCE;
    if (Math.random() < chance) {
      const ok = Math.random() < (gw.online ? ONLINE_SUCCESS : OFFLINE_SUCCESS);
      return {
        ...gw,
        status: ok ? ('succeeded' as const) : ('failed' as const),
        attempts: gw.attempts + 1,
        reportedAt: gw.reportedAt ?? now,
        lastReportedAt: now
      };
    }
    return gw;
  });

  const stats = recomputeStats({ ...batch, gateways }, group);

  // 暂停中：只合并迟到结果，不推进波次、不完成、不自动暂停
  if (!wasRunning) {
    return { batch: { ...batch, gateways, ...stats }, events };
  }

  // 波次结算：前一波网关都有了最终结果才放下一波
  while (activeWave < WAVE_COUNT - 1 && waveSettled({ ...batch, gateways }, activeWave)) {
    activeWave++;
    events.push(`批次 ${batch.id} 第 ${activeWave} 波网关已全部回报，开始第 ${activeWave + 1} 波`);
  }

  // 全部波次结算 -> 完成；仍未回来的离线网关留成待核对
  if (activeWave === WAVE_COUNT - 1 && waveSettled({ ...batch, gateways }, WAVE_COUNT - 1)) {
    gateways = gateways.map((gw) => (gw.status === 'pending' ? { ...gw, status: 'pending_verification' as const } : gw));
    status = 'completed';
    pausedReason = null;
    const doneStats = recomputeStats({ ...batch, gateways }, group);
    events.push(`批次 ${batch.id} 发布完成，已更新 ${doneStats.downloaded}，失败待重试 ${doneStats.failed}，待核对 ${doneStats.pendingVerification}`);
    return { batch: { ...batch, gateways, activeWave, ...doneStats, status, pausedReason }, events };
  }

  // 失败率超过阈值（且已有足够样本）-> 自动暂停并记下原因
  if (stats.reported >= MIN_SAMPLE && stats.failureRate > batch.failureThreshold) {
    status = 'paused';
    pausedReason = `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${batch.failureThreshold}%，自动暂停`;
    events.push(`批次 ${batch.id} ${pausedReason}`);
  }

  return { batch: { ...batch, gateways, activeWave, ...stats, status, pausedReason }, events };
}

/** 继续发布前按最新结果再判一次：仍超阈值则保持暂停，否则继续 */
export function recheckBeforeResume(
  batch: ReleaseBatch,
  group: DeviceGroup | undefined
): { batch: ReleaseBatch; event: string | null } {
  if (batch.status !== 'paused') return { batch, event: null };
  const stats = recomputeStats(batch, group);
  if (stats.failureRate > batch.failureThreshold) {
    return {
      batch: { ...batch, ...stats },
      event: `批次 ${batch.id} 继续前重判：失败率 ${stats.failureRate.toFixed(1)}% 仍超过阈值 ${batch.failureThreshold}%，保持暂停`
    };
  }
  return {
    batch: { ...batch, status: 'running', pausedReason: null, ...stats, updatedAt: new Date().toISOString() },
    event: `批次 ${batch.id} 继续前重判通过（失败率 ${stats.failureRate.toFixed(1)}% ≤ 阈值 ${batch.failureThreshold}%），继续发布`
  };
}

function migrateBatch(raw: Partial<ReleaseBatch>, groups: DeviceGroup[]): ReleaseBatch {
  const group = groups.find((g) => g.id === raw.groupId);
  const rolloutPercent = raw.rolloutPercent ?? 0;
  const target = targetCount(group, rolloutPercent);
  const waveCount = WAVE_COUNT;
  const downloaded = raw.downloaded ?? 0;
  const failed = raw.failed ?? 0;
  let gateways: GatewayInstall[];
  if (Array.isArray(raw.gateways) && raw.gateways.length) {
    gateways = raw.gateways as GatewayInstall[];
  } else {
    // 旧数据升级：按已更新 / 失败 / 待回来补全网关结果，拆成前后两波
    const waveSize = Math.ceil(target / waveCount);
    gateways = [];
    for (let i = 0; i < target; i++) {
      const wave = Math.min(waveCount - 1, Math.floor(i / waveSize));
      let status: GatewayResultStatus = 'pending';
      if (i < downloaded) status = 'succeeded';
      else if (i < downloaded + failed) status = 'failed';
      if (raw.status === 'completed' && status === 'pending') status = 'pending_verification';
      gateways.push({
        gatewayId: `${raw.groupId}-gw-${i}`,
        wave,
        online: isOnline(raw.groupId ?? '', i),
        status,
        attempts: status === 'pending' ? 0 : 1,
        resultKey: `${raw.groupId}-gw-${i}|${raw.firmware}|install`,
        reportedAt: status === 'pending' ? null : (raw.updatedAt ?? null),
        lastReportedAt: status === 'pending' ? null : (raw.updatedAt ?? null),
        reconciled: false
      });
    }
  }
  const stats = recomputeStats({ ...raw, gateways } as ReleaseBatch, group);
  const waveSize = Math.ceil(target / waveCount);
  const reported = downloaded + failed;
  const activeWave =
    raw.activeWave ??
    (raw.status === 'completed'
      ? waveCount - 1
      : raw.status === 'running'
        ? Math.min(waveCount - 1, Math.floor(reported / waveSize))
        : -1);
  const status = raw.status ?? 'draft';
  const pausedReason =
    raw.pausedReason ??
    (status === 'paused' && stats.failureRate > (raw.failureThreshold ?? 0)
      ? `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${raw.failureThreshold}%，自动暂停（升级前数据）`
      : null);
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: raw.name ?? '未命名批次',
    firmware: raw.firmware ?? '',
    rollbackVersion: raw.rollbackVersion ?? '',
    groupId: raw.groupId ?? '',
    rolloutPercent,
    failureThreshold: raw.failureThreshold ?? 0,
    status,
    progress: raw.progress ?? stats.progress,
    downloaded: stats.downloaded,
    failed: stats.failed,
    pendingVerification: stats.pendingVerification,
    pendingOffline: stats.pendingOffline,
    failureRate: stats.failureRate,
    waveCount,
    activeWave,
    pausedReason,
    gateways,
    updatedAt: raw.updatedAt ?? new Date().toISOString()
  };
}

/** 旧数据升级：检测旧形状并补全波次与网关结果，升级后仍能打开 */
export function migrateState(raw: unknown, fallback: ReleaseState): ReleaseState {
  if (!raw || typeof raw !== 'object') return fallback;
  const state = raw as Partial<ReleaseState>;
  const groups = state.groups ?? fallback.groups;
  const audits = state.audits ?? fallback.audits;
  const batches = (state.batches ?? []).map((b) => migrateBatch(b as Partial<ReleaseBatch>, groups));
  return { version: 2, groups, batches, audits };
}
