import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, telemetryTick } from './state/release.actions';
import { selectAudits, selectBatches, selectGroups, selectPendingVerificationCount, selectReconciliation } from './state/release.selectors';
import { WAVE_COUNT } from './state/release.logic';
import type { ReleaseBatch } from './state/release.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>审计可追踪</mat-chip><mat-chip>失败阈值自动暂停</mat-chip><mat-chip>波次灰度 · 离线合并</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ (groups$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停</span><strong>{{ pausedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待核对</span><strong>{{ pendingVerificationCount$ | async }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建兼容批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="196" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row">
                  <div><b>{{ batch.name }}</b><small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }} · 共 {{ batch.waveCount }} 波</small></div>
                  <mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }}</mat-chip>
                </div>

                <div class="wave-row">
                  <span class="wave-tag" *ngFor="let w of waveIndexes(batch)" [class.active]="batch.status === 'running' && batch.activeWave === w" [class.done]="batch.activeWave > w || batch.status === 'completed'">
                    第 {{ w + 1 }} 波<em *ngIf="batch.status === 'running' && batch.activeWave === w">进行中</em><em *ngIf="batch.activeWave > w || batch.status === 'completed'">已完成</em>
                  </span>
                </div>

                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.progress }}%</span><span class="rate">失败率 {{ batch.failureRate | number:'1.1-1' }}%（{{ batch.failed }}/{{ reported(batch) }} 已回报，不含 {{ batch.pendingOffline }} 待回来）</span></div>

                <mat-chip-set class="breakdown">
                  <mat-chip>已更新 {{ batch.downloaded }}</mat-chip>
                  <mat-chip [color]="batch.failed ? 'warn' : undefined">失败待重试 {{ batch.failed }}</mat-chip>
                  <mat-chip>待核对 {{ batch.pendingVerification }}</mat-chip>
                  <mat-chip>待回来 {{ batch.pendingOffline }}</mat-chip>
                </mat-chip-set>

                <p class="reason" *ngIf="batch.status === 'paused' && batch.pausedReason">⚠ {{ batch.pausedReason }}</p>

                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>对账（批次结束后到的结果只进对账，不翻状态）</mat-card-title></mat-card-header>
        <mat-card-content>
          <div class="audit-list">
            <div class="audit" *ngFor="let item of reconciliation$ | async"><span>{{ item.reportedAt | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.batchName }}</b><p>网关 {{ item.gatewayId }} · {{ item.result === 'succeeded' ? '已更新' : '失败' }} · 重传 {{ item.attempts }} 次</p></div>
            <p class="empty" *ngIf="(reconciliation$ | async)?.length === 0">暂无对账记录</p>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; flex-wrap:wrap }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:620px; } .batch { min-height:184px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .wave-row { display:flex;gap:8px;flex-wrap:wrap } .wave-tag { font-size:12px; padding:2px 10px; border-radius:12px; background:#eef3f4; color:#607d86; display:inline-flex; gap:6px; align-items:center } .wave-tag.active { background:#e0f2f1; color:#0f6f6c; font-weight:600 } .wave-tag.done { background:#e8f5e9; color:#2e7d32 } .wave-tag em { font-style:normal; font-size:11px; opacity:.8 }
    .rate { font-size:12px; color:#607d86 } .breakdown { display:flex;gap:8px;flex-wrap:wrap } .reason { margin:0; font-size:13px; color:#c62828; background:#ffebee; padding:6px 10px; border-radius:6px }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 } .empty { color:#90a4ae; font-size:13px }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly reconciliation$ = this.store.select(selectReconciliation);
  readonly pendingVerificationCount$ = this.store.select(selectPendingVerificationCount);
  private timer?: number;
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectBatches).subscribe((batches) => localStorage.setItem('firmware-release-v1', JSON.stringify({ version: 2, groups: this.snapshotGroups(), batches, audits: this.snapshotAudits() })));
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }
  pausedCount() { let count = 0; this.batches$.subscribe((items) => count = items.filter((item) => item.status === 'paused').length); return count; }
  waveIndexes(batch: ReleaseBatch): number[] { return Array.from({ length: batch.waveCount }, (_, i) => i); }
  reported(batch: ReleaseBatch): number { return batch.downloaded + batch.failed; }
  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = {
      ...this.draft,
      id: crypto.randomUUID(),
      status: 'draft',
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
      updatedAt: new Date().toISOString()
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  private snapshotGroups() { let value: unknown; this.groups$.subscribe((items) => value = items); return value; }
  private snapshotAudits() { let value: unknown; this.audits$.subscribe((items) => value = items); return value; }
}
