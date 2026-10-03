import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);

/** 对账：批次结束后才到的安装结果（reconciled），只进对账不翻状态 */
export const selectReconciliation = createSelector(selectBatches, (batches) =>
  batches.flatMap((batch) =>
    batch.gateways
      .filter((gw) => gw.reconciled)
      .map((gw) => ({
        batchId: batch.id,
        batchName: batch.name,
        gatewayId: gw.gatewayId,
        firmware: batch.firmware,
        result: gw.status,
        attempts: gw.attempts,
        reportedAt: gw.lastReportedAt ?? gw.reportedAt
      }))
  )
);

/** 待核对总数：批次结束仍未回来的网关 */
export const selectPendingVerificationCount = createSelector(selectBatches, (batches) =>
  batches.reduce((sum, batch) => sum + batch.pendingVerification, 0)
);
