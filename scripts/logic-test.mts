/* 纯逻辑验证：波次门禁 / 离线合并 / 去重 / 待重试 / 对账隔离 / 阈值暂停复核 / v1 迁移 */
import assert from 'node:assert/strict';
import {
  applyReport,
  createPlan,
  finalizeWave,
  markReportPending,
  startWave,
  tally,
  migrateBatch,
  type ReportEffect,
} from '../src/app/state/release.engine';
import type { ReleaseBatch } from '../src/app/state/release.models';

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const now = '2026-10-03T00:00:00.000Z';
let seq = 0;
const rid = (p: string) => `${p}-${++seq}`;

function makeBatch(over: Partial<ReleaseBatch> = {}): ReleaseBatch {
  const plan = createPlan(10, 2, now); // 前波 5（含 2 离线），后波 5
  return {
    id: 'b1', name: 't', firmware: '1', rollbackVersion: '0', groupId: 'g',
    rolloutPercent: 10, failureThreshold: 20, status: 'approved', updatedAt: now,
    waves: plan.waves, gateways: plan.gateways, activeWave: null, tick: 0,
    reconcile: [], resultIds: [], ...over,
  };
}

function dispatchWaiting(b: ReleaseBatch): ReleaseBatch {
  return { ...b, gateways: b.gateways.map((g) => (g.state === 'waiting' ? { ...g, state: 'dispatched', dueTick: 1 } : g)) };
}

// 1. 前波全部落定前，后波保持 pending
{
  let b = startWave(makeBatch(), 0, now);
  assert.equal(b.waves[1].status, 'pending');
  b = dispatchWaiting(b);
  // 只回报 2 台成功，仍有在途/离线 -> 不能关波
  const online = b.gateways.filter((g) => g.state === 'dispatched');
  b = applyReport(b, online[0].id, rid('r'), 'succeeded', now).batch;
  b = applyReport(b, online[1].id, rid('r'), 'succeeded', now).batch;
  assert.equal(b.waves[0].status, 'running', '前波未结束前仍是 running');
  assert.equal(b.waves[1].status, 'pending', '后波不得提前放行');
  // 宽限关闭：未回来的转 unverified
  b = finalizeWave(b, 0, now);
  b = startWave(b, 1, now);
  assert.equal(b.waves[0].status, 'finalized');
  assert.equal(b.waves[1].status, 'running', '前波落定后才放行后波');
  const u0 = b.gateways.filter((g) => g.waveIndex === 0 && g.state === 'unverified').length;
  assert.ok(u0 >= 3, `一直没回来的留待核对，实际 ${u0}`);
  ok('前波有最终结果/待核对后才放下一波，未回报留待核对');
}

// 2. 离线不计分母；回网后结果合并，失败率变化
{
  let b = startWave(makeBatch({ failureThreshold: 50 }), 0, now);
  b = dispatchWaiting(b);
  const online = b.gateways.filter((g) => g.state === 'dispatched');
  // 3 台在线：2 成功 1 失败
  b = applyReport(b, online[0].id, rid('r'), 'succeeded', now).batch;
  b = applyReport(b, online[1].id, rid('r'), 'succeeded', now).batch;
  b = applyReport(b, online[2].id, rid('r'), 'failed', now).batch;
  let s = tally(b);
  assert.equal(s.confirmed, 3, '分母只含已确认结果');
  assert.equal(s.offline, 2, '离线网关单列');
  assert.ok(Math.abs(s.failureRate - 100 / 3) < 1e-6, `失败率 1/3，实际 ${s.failureRate}`);
  // 关波 -> 2 台离线 + 0 在途全转 unverified；后波启动后，前波离线网关"回网"（unverified）补报成功
  b = finalizeWave(b, 0, now);
  const late = b.gateways.filter((g) => g.state === 'unverified');
  b = applyReport(b, late[0].id, rid('r'), 'succeeded', now).batch;
  b = applyReport(b, late[1].id, rid('r'), 'succeeded', now).batch;
  s = tally(b);
  assert.equal(s.succeeded, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.confirmed, 5);
  assert.equal(s.failureRate, 20, '合并后失败率重算为 20%');
  assert.equal(s.unverified, 0);
  ok('离线不进分母；回网结果合并，失败率随之重算');
}

// 3. 同一条结果重传只计一次
{
  let b = startWave(makeBatch(), 0, now);
  b = dispatchWaiting(b);
  const g = b.gateways.find((x) => x.state === 'dispatched')!;
  const same = rid('fixed');
  let r = applyReport(b, g.id, same, 'failed', now);
  b = r.batch;
  assert.equal(r.effect, 'new');
  r = applyReport(b, g.id, same, 'failed', now);
  assert.equal(r.effect, 'duplicate' as ReportEffect);
  assert.equal(r.batch, b, '重传返回同一引用，状态不变');
  // 换 resultId 的冲突报文也被忽略
  r = applyReport(b, g.id, rid('other'), 'succeeded', now);
  assert.equal(r.effect, 'duplicate');
  assert.equal(tally(b).failed, 1);
  assert.equal(b.resultIds.length, 1);
  ok('同一 resultId 重传只算一次，冲突报文不翻盘');
}

// 4. 上报失败保留待重试，重报成功后才入账
{
  let b = startWave(makeBatch(), 0, now);
  b = dispatchWaiting(b);
  const g = b.gateways.find((x) => x.state === 'dispatched')!;
  b = markReportPending(b, g.id, 'failed', now);
  let s = tally(b);
  assert.equal(s.retryPending, 1);
  assert.equal(s.confirmed, 0, '待重报未确认前不计入分母');
  assert.equal(s.failureRate, 0);
  // 保留内容重报
  const id = rid('r');
  b = applyReport(b, g.id, id, 'failed', now).batch;
  s = tally(b);
  assert.equal(s.retryPending, 0);
  assert.equal(s.failed, 1);
  assert.equal(s.confirmed, 1);
  // 再来一次同 id 重传 -> 丢弃
  assert.equal(applyReport(b, g.id, id, 'failed', now).effect, 'duplicate');
  ok('上报失败保留待重试，确认后才计数且可去重');
}

// 5. 批次结束后到达只进对账，不翻回发布中
{
  let b = makeBatch({ status: 'completed', activeWave: null });
  const g = b.gateways[0];
  const r = applyReport(b, g.id, rid('late'), 'failed', now);
  b = r.batch;
  assert.equal(r.effect, 'reconcile');
  assert.equal(b.status, 'completed', '状态不翻回发布中');
  assert.equal(b.reconcile.length, 1);
  assert.equal(b.reconcile[0].outcome, 'failed');
  // 迟到结果重传也去重
  assert.equal(applyReport(b, g.id, b.reconcile[0].resultId, 'failed', now).effect, 'duplicate');
  assert.equal(b.reconcile.length, 1);
  ok('批次结束后到达只进对账，不回翻状态，重传同样去重');
}

// 6. 阈值自动暂停 + 继续前复核
{
  // 引擎层：模拟 reducer 的判定——失败率超阈值
  let b = startWave(makeBatch({ failureThreshold: 30 }), 0, now);
  b = dispatchWaiting(b);
  const online = b.gateways.filter((g) => g.state === 'dispatched');
  b = applyReport(b, online[0].id, rid('r'), 'failed', now).batch;
  b = applyReport(b, online[1].id, rid('r'), 'succeeded', now).batch;
  b = applyReport(b, online[2].id, rid('r'), 'succeeded', now).batch;
  const s = tally(b);
  assert.ok(s.failureRate > 30, `失败率 ${s.failureRate}% 应超 30% 阈值`);
  // 暂停期间又来成功，复核放行判定：失败率降到阈值内 -> 可继续（reducer 中 resume 的条件）
  b = { ...b, status: 'paused', pauseReason: 'test' };
  const beforeResume = tally(b);
  assert.ok(beforeResume.failureRate > b.failureThreshold, '暂停瞬间仍超阈值，继续应被拦截');
  b = applyReport(b, online[3].id, rid('r'), 'succeeded', now).batch;
  const after = tally(b);
  assert.ok(after.failureRate <= b.failureThreshold, `新结果合并后失败率 ${after.failureRate}% 回落至阈值内，可继续`);
  ok('失败率超阈值暂停，继续前按最新结果再判一次');
}

// 7. v1 旧数据迁移
{
  const old = {
    id: 'old-1', name: '旧批次', firmware: '2', rollbackVersion: '1', groupId: 'g',
    rolloutPercent: 50, failureThreshold: 5, status: 'running' as const,
    progress: 40, downloaded: 4, failed: 1, updatedAt: now,
  };
  const b = migrateBatch({ ...old, _groupCount: 20 }, 3, now);
  assert.equal(b.gateways.length, 10, '20*50%=10 台');
  assert.ok(b.waves.length === 2 && b.waves[0].total === 5 && b.waves[1].total === 5);
  assert.equal(b.status, 'running');
  assert.equal(b.waves[0].status, 'running');
  assert.equal(b.activeWave, 0);
  assert.equal(tally(b).failed, 1);
  assert.equal(tally(b).succeeded, 3);
  assert.ok(b.gateways.filter((g) => g.state === 'offline').length <= 3);
  assert.ok(b.pauseReason === undefined);

  // 已完成的旧批次：两波 finalized，全部网关有终态（未回报的转待核对）
  const done = migrateBatch({ ...old, _groupCount: 20, status: 'completed', downloaded: 10, failed: 2 }, 0, now);
  assert.equal(done.waves.every((w) => w.status === 'finalized'), true);
  assert.equal(tally(done).succeeded, 8);
  assert.equal(tally(done).failed, 2);

  // 暂停的旧批次保留暂停原因，继续前复核
  const paused = migrateBatch({ ...old, _groupCount: 20, status: 'paused' as const }, 0, now);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.pauseReason);
  ok('v1 旧数据升级后可打开：波次/网关/计数/状态完整');
}

// 8. 回滚后状态不再变更
{
  const b = makeBatch({ status: 'rolled_back', activeWave: null });
  const r = applyReport(b, b.gateways[0].id, rid('x'), 'succeeded', now);
  assert.equal(r.effect, 'reconcile');
  assert.equal(r.batch.status, 'rolled_back');
  ok('回滚后迟到结果进对账，回滚态保持');
}

console.log(`\n全部 ${passed} 组逻辑验证通过`);
