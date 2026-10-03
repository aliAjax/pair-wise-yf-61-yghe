import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, GatewayState, GatewayTask, ReleaseBatch, ReleaseState } from './release.models';
import {
  approveBatch,
  createBatch,
  pauseBatch,
  reportInstallResult,
  resumeBatch,
  retryPendingReport,
  rollbackBatch,
  telemetryTick,
} from './release.actions';
import {
  WAVE_GRACE_TICKS,
  applyReport,
  createPlan,
  finalizeWave,
  isBatchFinished,
  markReportPending,
  startWave,
  tally,
} from './release.engine';
import { loadInitialState } from './release.storage';

const nowIso = () => new Date().toISOString();

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 },
];
const now = nowIso();
const demoPlan = createPlan(Math.round((680 * 20) / 100), 4, now);
const initialBatches: ReleaseBatch[] = [
  {
    id: 'batch-demo',
    name: '边缘网关安全补丁 2.8.1',
    firmware: '2.8.1',
    rollbackVersion: '2.7.9',
    groupId: 'g-edge',
    rolloutPercent: 20,
    failureThreshold: 5,
    status: 'approved',
    updatedAt: now,
    waves: demoPlan.waves,
    gateways: demoPlan.gateways,
    activeWave: null,
    tick: 0,
    reconcile: [],
    resultIds: [],
  },
];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];
const fallback: ReleaseState = { version: 2, groups: initialGroups, batches: initialBatches, audits: initialAudits };
const initialState = loadInitialState(fallback);

function addAudit(state: ReleaseState, actor: string, message: string): AuditEntry[];
function addAudit(audits: AuditEntry[], actor: string, message: string): AuditEntry[];
function addAudit(source: ReleaseState | AuditEntry[], actor: string, message: string): AuditEntry[] {
  const list = Array.isArray(source) ? source : source.audits;
  return [{ id: crypto.randomUUID(), at: nowIso(), actor, message }, ...list];
}

function updateBatch(state: ReleaseState, id: string, patch: (batch: ReleaseBatch) => ReleaseBatch): ReleaseBatch[] {
  return state.batches.map((batch) => (batch.id === id ? patch(batch) : batch));
}

// ---- 遥测模拟：网关回网 / 派发 / 回报（含上报失败与重传）/ 波次超时 ----

interface TickOutcome {
  batch: ReleaseBatch;
  mergedLate: number; // 回网后补报、合并进已关闭波次的结果数
  reconciled: number; // 批次结束后到达、只进对账的结果数
}

function simulateTick(input: ReleaseBatch, rolloutActive: boolean): TickOutcome {
  const tick = input.tick + 1;
  let working: ReleaseBatch = { ...input, tick, updatedAt: nowIso() };
  let mergedLate = 0;
  let reconciled = 0;
  const active = working.activeWave;
  const wave = active != null ? working.waves[active] : undefined;

  // 离线网关回网：当前波立刻补发；之前波次的离线网关回网后直接补报、合并结果（失败率随之变化）
  if (wave) {
    const lateToReport: string[] = [];
    working = {
      ...working,
      gateways: working.gateways.map((gw) => {
        if (gw.state !== 'offline' || Math.random() >= 0.18) return gw;
        if (gw.waveIndex === active) {
          return { ...gw, state: 'waiting' as GatewayState };
        }
        if (gw.waveIndex < active!) {
          lateToReport.push(gw.id);
        }
        return gw;
      }),
    };
    for (const gatewayId of lateToReport) {
      const outcome: 'succeeded' | 'failed' = Math.random() < 0.25 ? 'failed' : 'succeeded';
      const applied = applyReport(working, gatewayId, `r-${working.id}-${gatewayId}`, outcome, nowIso());
      if (applied.effect === 'new') {
        working = applied.batch;
        mergedLate += 1;
      }
    }
  }

  // 已转为待核对的网关回网补报：结果合并进来，但不改变波次/批次状态
  if (wave || isBatchFinished(working)) {
    const recovered = working.gateways.filter(
      (gw) => gw.state === 'unverified' && (isBatchFinished(working) || gw.waveIndex <= (active ?? 0)) && Math.random() < 0.1
    );
    for (const gw of recovered) {
      const outcome: 'succeeded' | 'failed' = Math.random() < 0.2 ? 'failed' : 'succeeded';
      const applied = applyReport(working, gw.id, `r-${working.id}-${gw.id}`, outcome, nowIso());
      if (applied.effect === 'new') {
        working = applied.batch;
        mergedLate += 1;
      } else if (applied.effect === 'reconcile') {
        working = applied.batch;
        reconciled += 1;
      }
    }
  }

  if (wave && wave.status === 'running') {
    // 派发当前波尚未派发的网关（回网网关随下一批一起派发）——暂停期间不新派发
    if (rolloutActive) {
      const due = working.gateways.filter((gw) => gw.waveIndex === active! && gw.state === 'waiting');
      if (due.length) {
        const ids = new Set(due.slice(0, Math.ceil(due.length / 2)).map((gw) => gw.id));
        working = {
          ...working,
          gateways: working.gateways.map((gw) =>
            ids.has(gw.id) && gw.state === 'waiting'
              ? { ...gw, state: 'dispatched' as GatewayState, dueTick: tick + 2 + Math.floor(Math.random() * 3) }
              : gw
          ),
        };
      }
    }

    // 在途网关回报（或上报失败进入待重试）
    for (const gw of [...working.gateways]) {
      if (gw.waveIndex !== active! || gw.state !== 'dispatched' || gw.dueTick == null || gw.dueTick > tick) continue;
      if (Math.random() < 0.55) {
        const outcome: 'succeeded' | 'failed' = Math.random() < 0.09 ? 'failed' : 'succeeded';
        const resultId = `r-${working.id}-${gw.id}`;
        if (Math.random() < 0.1) {
          // 上报失败：结果保留待重试，不计入分母
          working = markReportPending(working, gw.id, outcome, nowIso());
        } else {
          working = applyReport(working, gw.id, resultId, outcome, nowIso()).batch;
          if (Math.random() < 0.4) {
            // 网关重传同一条结果：必须被去重丢弃
            working = applyReport(working, gw.id, resultId, outcome, nowIso()).batch;
          }
        }
      }
    }

    // 待重试报文按保留内容重发，成功后才计入结果
    working = {
      ...working,
      gateways: working.gateways.map((gw) => {
        if (gw.state !== 'retry_pending' || !gw.pendingOutcome || gw.resent || Math.random() < 0.4) return gw;
        const next: GatewayTask = {
          ...gw,
          state: gw.pendingOutcome,
          resultId: `r-${working.id}-${gw.id}`,
          reportedAt: nowIso(),
          pendingOutcome: undefined,
          resent: true,
          dueTick: undefined,
        };
        return next;
      }),
    };

    // 波次关闭：全部派发完（无 waiting）起算宽限期；宽限到期仍未回来的（含在途/离线）一律留成待核对。暂停期间不关门
    if (rolloutActive) {
      const waveGateways = working.gateways.filter((gw) => gw.waveIndex === active!);
      const noneWaiting = !waveGateways.some((gw) => gw.state === 'waiting');
      let closeAfterTick = wave.closeAfterTick;
      if (noneWaiting && closeAfterTick == null) {
        closeAfterTick = tick + WAVE_GRACE_TICKS;
        working = {
          ...working,
          waves: working.waves.map((item) => (item.index === active! ? { ...item, closeAfterTick } : item)),
        };
      }
      const noneInFlight = !waveGateways.some((gw) => gw.state === 'dispatched' || gw.state === 'offline');
      if (noneWaiting && (noneInFlight || (closeAfterTick != null && tick >= closeAfterTick))) {
        working = finalizeWave(working, active!, nowIso());
      }
    }
  }

  return { batch: working, mergedLate, reconciled };
}

/** 波次关闭后自动放下一波；最后一波关闭则批次完成 */
function advanceWave(batch: ReleaseBatch): ReleaseBatch {
  const finalized = batch.waves.find((wave) => wave.index === batch.activeWave && wave.status === 'finalized');
  if (!finalized) return batch;
  const nextIndex = finalized.index + 1;
  if (nextIndex >= batch.waves.length) {
    return { ...batch, status: 'completed', activeWave: null, updatedAt: nowIso() };
  }
  return startWave({ ...batch, updatedAt: nowIso() }, nextIndex, nowIso());
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { draft }) => {
    const group = state.groups.find((item) => item.id === draft.groupId);
    if (!group?.compatible) return state;
    const target = Math.round((group.count * draft.rolloutPercent) / 100);
    const plan = createPlan(target, group.offlineGateways, nowIso());
    const batch: ReleaseBatch = {
      id: crypto.randomUUID(),
      ...draft,
      status: 'draft',
      updatedAt: nowIso(),
      waves: plan.waves,
      gateways: plan.gateways,
      activeWave: null,
      tick: 0,
      reconcile: [],
      resultIds: [],
    };
    return { ...state, batches: [batch, ...state.batches], audits: addAudit(state, '发布负责人', `创建批次 ${batch.name}，拆分为 ${plan.waves.length} 个波次`) };
  }),
  on(approveBatch, (state, { id, actor }) => ({
    ...state,
    batches: updateBatch(state, id, (batch) => (batch.status === 'draft' ? { ...batch, status: 'approved', updatedAt: nowIso() } : batch)),
    audits: addAudit(state, actor, `批次 ${id} 审批通过`),
  })),
  on(pauseBatch, (state, { id, actor, reason }) => ({
    ...state,
    batches: updateBatch(state, id, (batch) =>
      batch.status === 'running'
        ? { ...batch, status: 'paused', pauseReason: reason ?? '值班手动暂停，继续前按最新结果复核失败率', updatedAt: nowIso() }
        : batch
    ),
    audits: addAudit(state, actor, reason ? `批次 ${id} 已自动暂停：${reason}` : `批次 ${id} 已暂停`),
  })),
  on(resumeBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'paused' && batch.status !== 'approved')) return state;
    // 继续发布前按最新结果再判一次：仍超阈值就不放行
    const stats = tally(batch);
    if (batch.status === 'paused' && stats.confirmed > 0 && stats.failureRate > batch.failureThreshold) {
      return { ...state, audits: addAudit(state, actor, `批次 ${id} 继续被拦截：当前失败率 ${stats.failureRate.toFixed(1)}% 仍超阈值 ${batch.failureThreshold}%`) };
    }
    let next: ReleaseBatch = { ...batch, status: 'running', pauseReason: undefined, updatedAt: nowIso() };
    if (batch.status === 'approved' || batch.activeWave == null) {
      next = startWave(next, 0, nowIso());
    }
    return {
      ...state,
      batches: updateBatch(state, id, () => next),
      audits: addAudit(state, actor, batch.status === 'approved' ? `批次 ${id} 开始发布，前波先行` : `批次 ${id} 恢复发布，复核失败率 ${stats.failureRate.toFixed(1)}% 通过`),
    };
  }),
  on(rollbackBatch, (state, { id, actor }) => ({
    ...state,
    batches: updateBatch(state, id, (batch) =>
      isBatchFinished(batch) ? batch : { ...batch, status: 'rolled_back', activeWave: null, updatedAt: nowIso() }
    ),
    audits: addAudit(state, actor, `批次 ${id} 已紧急回滚，后续到达结果只进对账`),
  })),
  on(reportInstallResult, (state, { batchId, gatewayId, resultId, outcome }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch) return state;
    const { batch: next, effect } = applyReport(batch, gatewayId, resultId, outcome, nowIso());
    if (effect === 'duplicate' || next === batch) return state;
    let audits = state.audits;
    if (effect === 'reconcile') {
      audits = addAudit(state, '系统', `批次 ${batchId} 的迟到结果 ${resultId}（${outcome === 'failed' ? '失败' : '成功'}）已登记对账，状态不变`);
    }
    const stats = tally(next);
    if (next.status === 'running' && stats.confirmed > 0 && stats.failureRate > next.failureThreshold) {
      const reason = `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${next.failureThreshold}%（失败 ${stats.failed}/${stats.confirmed}）`;
      return {
        ...state,
        batches: updateBatch(state, batchId, () => ({ ...next, status: 'paused', pauseReason: reason })),
        audits: addAudit(audits, '系统', `批次 ${batchId} 自动暂停：${reason}`),
      };
    }
    return { ...state, batches: updateBatch(state, batchId, () => next), audits };
  }),
  on(retryPendingReport, (state, { batchId, gatewayId }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch) return state;
    const gw = batch.gateways.find((item) => item.id === gatewayId);
    if (!gw || gw.state !== 'retry_pending' || !gw.pendingOutcome) return state;
    const resultId = gw.resultId ?? `r-${batchId}-${gw.id}`;
    const { batch: next, effect } = applyReport(batch, gatewayId, resultId, gw.pendingOutcome, nowIso());
    if (effect === 'duplicate') return state;
    const stats = tally(next);
    const audits = addAudit(state, '系统', `批次 ${batchId} 网关 ${gatewayId} 保留的安装结果重报成功（${gw.pendingOutcome === 'failed' ? '失败' : '成功'}）`);
    if (next.status === 'running' && stats.confirmed > 0 && stats.failureRate > next.failureThreshold) {
      const reason = `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${next.failureThreshold}%（失败 ${stats.failed}/${stats.confirmed}）`;
      return {
        ...state,
        batches: updateBatch(state, batchId, () => ({ ...next, status: 'paused', pauseReason: reason })),
        audits: addAudit(audits, '系统', `批次 ${batchId} 自动暂停：${reason}`),
      };
    }
    return { ...state, batches: updateBatch(state, batchId, () => next), audits };
  }),
  on(telemetryTick, (state) => {
    let audits = state.audits;
    const autoPauseIds = new Set<string>();
    const batches = state.batches.map((input) => {
      const processing = input.status === 'running' || input.status === 'paused' || isBatchFinished(input);
      if (!processing) return input;
      const simulated = simulateTick(input, input.status === 'running');
      let batch = simulated.batch;
      if (simulated.mergedLate > 0) {
        audits = addAudit(audits, '系统', `批次 ${batch.id} 有 ${simulated.mergedLate} 台离线/待核对网关回网，结果已合并并按最新结果重算失败率`);
      }
      if (simulated.reconciled > 0) {
        audits = addAudit(audits, '系统', `批次 ${batch.id} 有 ${simulated.reconciled} 条迟到结果，仅登记对账，发布状态不变`);
      }
      if (input.status !== 'running') {
        // 暂停期间在途结果继续合并：失败率变化时更新暂停原因，值班一眼能区分真失败与没回来
        if (input.status === 'paused') {
          const stats = tally(batch);
          const reason = stats.confirmed > 0 && stats.failureRate > batch.failureThreshold
            ? `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${batch.failureThreshold}%（失败 ${stats.failed}/${stats.confirmed}）`
            : batch.pauseReason;
          batch = { ...batch, pauseReason: reason };
        }
        return batch;
      }
      batch = advanceWave(batch);
      const stats = tally(batch);
      // 失败率一变就重算：超过阈值立即自动暂停并记下原因
      if (batch.status === 'running' && stats.confirmed > 0 && stats.failureRate > batch.failureThreshold) {
        const reason = `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${batch.failureThreshold}%（失败 ${stats.failed}/${stats.confirmed}）`;
        batch = { ...batch, status: 'paused', pauseReason: reason };
        autoPauseIds.add(batch.id);
      }
      if (batch.status === 'completed' && input.status === 'running') {
        const late = stats.unverified + stats.retryPending;
        audits = addAudit(
          audits,
          '系统',
          late > 0
            ? `批次 ${batch.id} 所有波次结束：${stats.succeeded} 成功 / ${stats.failed} 失败，${stats.unverified} 台待核对、${stats.retryPending} 条结果待重报，迟到结果只进对账`
            : `批次 ${batch.id} 所有波次结束：${stats.succeeded} 成功 / ${stats.failed} 失败`
        );
      }
      if (batch.activeWave !== input.activeWave && batch.activeWave != null && batch.status === 'running') {
        audits = addAudit(audits, '系统', `批次 ${batch.id} 前波已全部落定，放行第 ${batch.activeWave + 1} 波`);
      }
      return batch;
    });
    for (const id of autoPauseIds) {
      const paused = batches.find((batch) => batch.id === id);
      if (paused) audits = addAudit(audits, '系统', `批次 ${id} 自动暂停：${paused.pauseReason}`);
    }
    return { ...state, batches, audits };
  })
);
