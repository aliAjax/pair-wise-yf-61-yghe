import "@angular/compiler";
/* reducer 集成验证：完整批次生命周期（波次门禁、去重计数、自动暂停与复核、迟到对账） */
import assert from 'node:assert/strict';
import { releaseReducer } from '../src/app/state/release.reducer';
import { loadInitialState, STORAGE_KEY } from '../src/app/state/release.storage';
import { createBatch, approveBatch, resumeBatch, pauseBatch, telemetryTick, reportInstallResult, rollbackBatch } from '../src/app/state/release.actions';
import type { ReleaseState } from '../src/app/state/release.models';
import { tally } from '../src/app/state/release.engine';

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// ---- localStorage 桩（Node 环境） ----
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
Object.defineProperty(globalThis, 'crypto', {
  value: { ...(globalThis.crypto ?? {}), randomUUID: () => `u-${Math.random().toString(36).slice(2)}` },
  configurable: true,
});

function freshState(threshold = 8): ReleaseState {
  mem.clear();
  // 小目标批次：20% of 50 = 10 台，2 台离线
  const state0: ReleaseState = {
    version: 2,
    groups: [
      { id: 'g', name: 'G', region: 'r', count: 50, compatible: true, offlineGateways: 2 },
      { id: 'bad', name: 'B', region: 'r', count: 10, compatible: false, offlineGateways: 0 },
    ],
    batches: [],
    audits: [],
  };
  let s = releaseReducer(state0, { type: '__init__' });
  s = releaseReducer(s, createBatch({ draft: { name: 'T', firmware: '1', rollbackVersion: '0', groupId: 'g', rolloutPercent: 20, failureThreshold: threshold } }));
  const id = s.batches[0].id;
  s = releaseReducer(s, approveBatch({ id, actor: 't' }));
  s = releaseReducer(s, resumeBatch({ id, actor: 't' }));
  return s;
}

function find(s: ReleaseState, id: string) {
  return s.batches.find((b) => b.id === id)!;
}

// 1. 波次门禁：前波 finalized 前，后波绝不 running；最终 completed 且结果不重复
{
  let s = freshState(100);
  const id = s.batches[0].id;
  const gateViolations: boolean[] = [];
  for (let i = 0; i < 200; i++) {
    s = releaseReducer(s, telemetryTick());
    const b = find(s, id);
    if (b.waves[1].status === 'running') assert.equal(b.waves[0].status, 'finalized', '后波启动时前波必须已落定');
    if (b.waves[0].status !== 'finalized' && b.waves[1].status === 'running') gateViolations.push(true);
    // 去重不变式：resultIds 无重复
    assert.equal(new Set(b.resultIds).size, b.resultIds.length, 'resultIds 不能重复');
    // 成功+失败+待核对+待重报+在途+等待+离线 = 总数
    const st = tally(b);
    assert.equal(st.succeeded + st.failed + st.unverified + st.retryPending + st.dispatched + st.waiting + st.offline, 10);
  }
  const b = find(s, id);
  assert.equal(b.status, 'completed', '200 tick 内批次应完成');
  assert.equal(gateViolations.length, 0);
  const st = tally(b);
  assert.ok(st.succeeded + st.failed + st.unverified === 10, '所有网关都有归宿');
  ok('前后波门禁严格、无重复计数、最终每台网关有归宿');
}

// 2. 手动上报：重传同一 resultId 只计一次；阈值超了自动暂停；继续前复核拦截/放行
{
  let s = freshState(50);
  const id = s.batches[0].id;
  // 直接手工操纵网关：派发全部 waiting，再报 2 成功 1 失败（33% <= 50%，不暂停）
  // 用 reportInstallResult 对 waiting/dispatched 网关都可入账（引擎不挑剔状态，除终态）
  const gws = () => find(s, id).gateways;
  const online = gws().filter((g) => g.state !== 'offline');
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: online[0].id, resultId: 'X-1', outcome: 'succeeded' }));
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: online[1].id, resultId: 'X-2', outcome: 'succeeded' }));
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: online[2].id, resultId: 'X-3', outcome: 'failed' }));
  // 重传三次
  for (let i = 0; i < 3; i++) s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: online[2].id, resultId: 'X-3', outcome: 'failed' }));
  let st = tally(find(s, id));
  assert.equal(st.failed, 1, '重传不重复计数');
  assert.equal(st.succeeded, 2);
  assert.equal(find(s, id).resultIds.length, 3);

  // 再报 2 个失败：3/5 = 60% > 50% -> 自动暂停（动作路径）
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: online[3].id, resultId: 'X-4', outcome: 'failed' }));
  let b = find(s, id);
  assert.equal(b.status, 'running'); // 33%? 2 fail /4 = 50% not > 50
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: online[4].id, resultId: 'X-5', outcome: 'failed' }));
  b = find(s, id);
  assert.equal(b.status, 'paused', '3/5=60% 超阈值必须自动暂停');
  assert.ok(b.pauseReason!.includes('超过阈值'));

  // 继续被拦截：当前仍 60%
  const auditsBefore = s.audits.length;
  s = releaseReducer(s, resumeBatch({ id, actor: 'ops' }));
  assert.equal(find(s, id).status, 'paused', '失败率未回落，继续应被拦截');
  assert.ok(s.audits.length > auditsBefore, '拦截应留审计');

  // 让失败率回落：直接把在途成功合并（暂停也可收结果）——再成功 5 台 => 3/10 = 30%
  const rest = gws().filter((g) => g.state === 'waiting' || g.state === 'dispatched');
  for (let i = 0; i < 5 && i < rest.length; i++) {
    s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: rest[i].id, resultId: `Y-${i}`, outcome: 'succeeded' }));
  }
  st = tally(find(s, id));
  assert.ok(st.failureRate <= 50, `失败率 ${st.failureRate}%`);
  s = releaseReducer(s, resumeBatch({ id, actor: 'ops' }));
  assert.equal(find(s, id).status, 'running', '复核通过后可继续');
  assert.equal(find(s, id).pauseReason, undefined);
  ok('结果重传只计一次；超阈值自动暂停记因；继续前复核先拦后放');
}

// 3. 批次结束后的迟到结果只进对账，状态不回翻
{
  let s = freshState(100);
  const id = s.batches[0].id;
  for (let i = 0; i < 200; i++) s = releaseReducer(s, telemetryTick());
  assert.equal(find(s, id).status, 'completed');

  // 3a. 已确认终态的网关：任何新 resultId 都是冲突报文，不进对账
  const terminal = find(s, id).gateways.find((g) => g.state === 'succeeded' || g.state === 'failed')!;
  const reconcileBefore = find(s, id).reconcile.length;
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: terminal.id, resultId: 'CONFLICT-1', outcome: 'failed' }));
  assert.equal(find(s, id).status, 'completed');
  assert.equal(find(s, id).reconcile.length, reconcileBefore, '冲突报文不进对账');
  assert.equal(find(s, id).resultIds.includes('CONFLICT-1'), false);

  // 3b. 未确认（待核对）网关回网补报：登记对账，状态不回翻，重传只一条
  const pending = find(s, id).gateways.find((g) => g.state === 'unverified');
  if (pending) {
    const auditsBefore = s.audits.length;
    s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: pending.id, resultId: 'LATE-1', outcome: 'failed' }));
    assert.equal(find(s, id).status, 'completed', '状态不翻回发布中');
    assert.equal(find(s, id).reconcile.length, reconcileBefore + 1);
    assert.ok(s.audits.length > auditsBefore);
    s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: pending.id, resultId: 'LATE-1', outcome: 'failed' }));
    assert.equal(find(s, id).reconcile.length, reconcileBefore + 1, '迟到结果重传也去重');
  }
  ok('结束后到达只进对账不回翻，冲突报文忽略、重传只一条');
}

// 4. 回滚后同样只对账
{
  let s = freshState(90);
  const id = s.batches[0].id;
  s = releaseReducer(s, rollbackBatch({ id, actor: 'lead' }));
  assert.equal(find(s, id).status, 'rolled_back');
  const g = find(s, id).gateways[0];
  s = releaseReducer(s, reportInstallResult({ batchId: id, gatewayId: g.id, resultId: 'RB-1', outcome: 'succeeded' }));
  assert.equal(find(s, id).status, 'rolled_back');
  assert.equal(find(s, id).reconcile.length, 1);
  ok('回滚后结果进对账，状态保持回滚');
}

// 5. 不兼容分组不能创建
{
  let s = freshState();
  const before = s.batches.length;
  s = releaseReducer(s, createBatch({ draft: { name: 'X', firmware: '1', rollbackVersion: '0', groupId: 'bad', rolloutPercent: 10, failureThreshold: 5 } }));
  assert.equal(s.batches.length, before);
  ok('兼容性检查仍生效');
}

// 6. v1 localStorage 旧数据升级可打开，且之后继续走 v2 流程
{
  mem.clear();
  const v1 = {
    groups: [
      { id: 'g', name: '华东', region: 'r', count: 40, compatible: true, offlineGateways: 1 },
    ],
    batches: [
      { id: 'legacy', name: '旧批次', firmware: '2', rollbackVersion: '1', groupId: 'g', rolloutPercent: 25, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, updatedAt: new Date().toISOString() },
      { id: 'legacy-run', name: '旧跑批', firmware: '2', rollbackVersion: '1', groupId: 'g', rolloutPercent: 50, failureThreshold: 5, status: 'running', progress: 20, downloaded: 4, failed: 1, updatedAt: new Date().toISOString() },
    ],
    audits: [],
  };
  mem.set('firmware-release-v1', JSON.stringify(v1));
  const loaded = loadInitialState({ version: 2, groups: [], batches: [], audits: [] });
  assert.equal(loaded.version, 2);
  assert.equal(loaded.batches.length, 2);
  const legacy = loaded.batches.find((b) => b.id === 'legacy')!;
  assert.equal(legacy.waves.length, 2);
  assert.equal(legacy.gateways.length, 10, '40*25%=10');
  assert.equal(legacy.status, 'approved');
  const running = loaded.batches.find((b) => b.id === 'legacy-run')!;
  assert.equal(running.gateways.length, 20);
  assert.equal(running.waves[0].status, 'running');
  assert.equal(tally(running).failed, 1);
  assert.equal(tally(running).succeeded, 3);
  // 升级数据已写入 v2 键
  assert.ok(mem.has(STORAGE_KEY));
  // 升级后的批次可继续操作：开始发布 -> 若干 tick -> 不崩
  let s = releaseReducer(loaded, resumeBatch({ id: 'legacy', actor: 'ops' }));
  assert.equal(s.batches.find((b) => b.id === 'legacy')!.waves[0].status, 'running');
  for (let i = 0; i < 60; i++) s = releaseReducer(s, telemetryTick());
  assert.ok(['running', 'paused', 'completed'].includes(s.batches.find((b) => b.id === 'legacy')!.status));
  ok('v1 旧数据升级为 v2 后可打开、可继续发布');
}

console.log(`\n全部 ${passed} 组 reducer 集成验证通过`);
