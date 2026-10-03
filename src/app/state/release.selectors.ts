import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';
import { tally, type BatchStats } from './release.engine';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);

export interface BatchView {
  batch: ReleaseState['batches'][number];
  stats: BatchStats;
  waves: Array<{ index: number; status: string; total: number; succeeded: number; failed: number; unverified: number; pending: number }>;
}

export const selectBatchViews = createSelector(selectRelease, (state) =>
  state.batches.map((batch) => {
    const stats = tally(batch);
    const waves = batch.waves.map((wave) => {
      const members = batch.gateways.filter((gw) => gw.waveIndex === wave.index);
      return {
        index: wave.index,
        status: wave.status,
        total: wave.total,
        succeeded: members.filter((gw) => gw.state === 'succeeded').length,
        failed: members.filter((gw) => gw.state === 'failed').length,
        unverified: members.filter((gw) => gw.state === 'unverified').length,
        pending: members.filter((gw) => gw.state === 'retry_pending').length,
      };
    });
    return { batch, stats, waves };
  })
);

export const selectPausedCount = createSelector(selectBatchViews, (views) => views.filter((view) => view.batch.status === 'paused').length);
export const selectUnverifiedTotal = createSelector(selectBatchViews, (views) => views.reduce((sum, view) => sum + view.stats.unverified, 0));
