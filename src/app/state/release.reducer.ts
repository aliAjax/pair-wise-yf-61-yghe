import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, ReleaseBatch, ReleaseState } from './release.models';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, telemetryTick } from './release.actions';
import { buildGateways, migrateState, recheckBeforeResume, simulateTick, STORAGE_KEY, WAVE_COUNT } from './release.logic';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];
const now = new Date().toISOString();
const demoBatchBase: ReleaseBatch = {
  id: 'batch-demo',
  name: '边缘网关安全补丁 2.8.1',
  firmware: '2.8.1',
  rollbackVersion: '2.7.9',
  groupId: 'g-edge',
  rolloutPercent: 20,
  failureThreshold: 5,
  status: 'approved',
  progress: 0,
  downloaded: 0,
  failed: 0,
  pendingVerification: 0,
  pendingOffline: 0,
  failureRate: 0,
  waveCount: WAVE_COUNT,
  activeWave: -1,
  pausedReason: null,
  gateways: [],
  updatedAt: now
};
const initialBatches: ReleaseBatch[] = [{ ...demoBatchBase, gateways: buildGateways(demoBatchBase, initialGroups[0]) }];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];
const fallback: ReleaseState = { version: 2, groups: initialGroups, batches: initialBatches, audits: initialAudits };

function loadState(): ReleaseState {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    return migrateState(raw, fallback);
  } catch {
    return fallback;
  }
}

const initialState = loadState();

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => {
    const group = state.groups.find((item) => item.id === batch.groupId);
    const withGateways: ReleaseBatch = {
      ...batch,
      waveCount: WAVE_COUNT,
      activeWave: -1,
      pausedReason: null,
      gateways: buildGateways(batch, group)
    };
    return { ...state, batches: [withGateways, ...state.batches], audits: audit(state, '发布负责人', `创建批次 ${batch.name}`) };
  }),
  on(approveBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state, actor, `批次 ${id} 审批通过`)
  })),
  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) =>
      batch.id === id ? { ...batch, status: 'paused', pausedReason: batch.pausedReason ?? '手动暂停', updatedAt: new Date().toISOString() } : batch
    ),
    audits: audit(state, actor, `批次 ${id} 已暂停`)
  })),
  on(resumeBatch, (state, { id, actor }) => {
    const events: string[] = [];
    const batches = state.batches.map((batch): ReleaseBatch => {
      if (batch.id !== id) return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      if (batch.status === 'approved') {
        events.push(`批次 ${batch.id} 开始发布`);
        return { ...batch, status: 'running', updatedAt: new Date().toISOString() };
      }
      if (batch.status === 'paused') {
        const result = recheckBeforeResume(batch, group);
        if (result.event) events.push(result.event);
        return result.batch;
      }
      return batch;
    });
    const newAudits = events.map((message) => ({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }));
    return { ...state, batches, audits: [...newAudits, ...state.audits] };
  }),
  on(rollbackBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'rolled_back', pausedReason: null, updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state, actor, `批次 ${id} 已紧急回滚`)
  })),
  on(telemetryTick, (state) => {
    const events: string[] = [];
    const batches = state.batches.map((batch) => {
      const group = state.groups.find((item) => item.id === batch.groupId);
      const result = simulateTick(batch, group);
      events.push(...result.events);
      return result.batch;
    });
    const newAudits = events.map((message) => ({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: '系统', message }));
    return { ...state, batches, audits: [...newAudits, ...state.audits] };
  })
);
