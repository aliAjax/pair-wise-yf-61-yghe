import { createAction, props } from '@ngrx/store';
import type { InstallOutcome } from './release.models';

export interface BatchDraft {
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
}

export const createBatch = createAction('[Release] Create batch', props<{ draft: BatchDraft }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string; reason?: string }>());
/** 继续发布：按最新结果重新判定失败率，仍超阈值则拒绝放行 */
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());

/** 模拟遥测：派发、网关回网、结果回报（含重传/上报失败）、超时关闭波次 */
export const telemetryTick = createAction('[Release] Telemetry tick');

/**
 * 网关上报安装结果。同一 resultId 重传只计一次；
 * 批次已结束时结果只进对账，不再把状态翻回发布中。
 */
export const reportInstallResult = createAction(
  '[Release] Report install result',
  props<{ batchId: string; gatewayId: string; resultId: string; outcome: InstallOutcome }>()
);

/** 重试此前上报失败而保留下来的安装结果 */
export const retryPendingReport = createAction(
  '[Release] Retry pending report',
  props<{ batchId: string; gatewayId: string }>()
);
