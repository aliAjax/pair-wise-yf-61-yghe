import { Component, OnDestroy, OnInit, inject } from '@angular/core';
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
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, retryPendingReport, telemetryTick } from './state/release.actions';
import { selectAudits, selectBatchViews, selectGroups, selectPausedCount, selectUnverifiedTotal, type BatchView } from './state/release.selectors';
import type { BatchStatus, WaveStatus } from './state/release.models';

const STATUS_TEXT: Record<BatchStatus, string> = {
  draft: '草稿',
  approved: '已审批',
  running: '发布中',
  paused: '已暂停',
  completed: '已完成',
  rolled_back: '已回滚',
};
const WAVE_TEXT: Record<WaveStatus, string> = { pending: '待命', running: '进行中', finalized: '已落定' };

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>波次门禁</mat-chip><mat-chip>结果去重</mat-chip><mat-chip>对账隔离</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (views$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停</span><strong>{{ (paused$ | async) ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待核对网关</span><strong>{{ (unverified$ | async) ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}（离线 {{ group.offlineGateways }}）</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" min="0" max="100" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" min="0" max="100" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建兼容批次（自动拆分前后波）</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="300" class="viewport">
              <article class="batch" *cdkVirtualFor="let view of views$ | async">
                <div class="row">
                  <div><b>{{ view.batch.name }}</b><small>{{ view.batch.firmware }} → 回滚 {{ view.batch.rollbackVersion }} · 阈值 {{ view.batch.failureThreshold }}%</small></div>
                  <mat-chip [color]="view.batch.status === 'paused' || view.batch.status === 'rolled_back' ? 'warn' : view.batch.status === 'completed' ? 'primary' : ''" [highlighted]="view.batch.status === 'paused'">{{ statusText(view.batch.status) }}</mat-chip>
                </div>

                <div class="pause-reason" *ngIf="view.batch.pauseReason">⚠ {{ view.batch.pauseReason }}</div>

                <div class="waves">
                  <div class="wave" *ngFor="let wave of view.waves">
                    <div class="wave-head"><span>{{ wave.index === 0 ? '前波' : '后波' }}</span><mat-chip [highlighted]="wave.status === 'running'">{{ waveText(wave.status) }}</mat-chip></div>
                    <small>共 {{ wave.total }} · 成功 {{ wave.succeeded }} · 失败 {{ wave.failed }}<ng-container *ngIf="wave.unverified"> · 待核对 {{ wave.unverified }}</ng-container><ng-container *ngIf="wave.pending"> · 待重报 {{ wave.pending }}</ng-container></small>
                  </div>
                </div>

                <mat-progress-bar mode="determinate" [value]="view.stats.progress"></mat-progress-bar>
                <div class="row metrics">
                  <span>成功 {{ view.stats.succeeded }} · 失败 {{ view.stats.failed }} · 待核对 {{ view.stats.unverified }} · 待重报 {{ view.stats.retryPending }} · 在途 {{ view.stats.dispatched }} · 离线 {{ view.stats.offline }}</span>
                  <span [class.over]="isOver(view)">失败率 {{ rate(view) }}%（分母 {{ view.stats.confirmed }}）</span>
                </div>

                <div class="reconcile" *ngIf="view.batch.reconcile.length">
                  <b>批次结束后到达，仅对账：</b>
                  <span *ngFor="let item of view.batch.reconcile.slice(0, 3)">· {{ item.gatewayId }} {{ item.outcome === 'failed' ? '失败' : '成功' }}（{{ item.receivedAt | date:'MM-dd HH:mm' }}）</span>
                </div>

                <div class="actions">
                  <button mat-stroked-button *ngIf="view.batch.status === 'draft'" (click)="approve(view.batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'approved'" (click)="resume(view.batch.id)">开始发布（前波先行）</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'running'" (click)="pause(view.batch.id)">暂停</button>
                  <button mat-stroked-button color="accent" *ngIf="view.batch.status === 'paused'" (click)="resume(view.batch.id)">继续（先复核失败率）</button>
                  <button mat-stroked-button *ngIf="view.stats.retryPending > 0" (click)="retryPending(view)">重发 {{ view.stats.retryPending }} 条保留结果</button>
                  <button mat-flat-button color="warn" [disabled]="view.batch.status === 'completed' || view.batch.status === 'rolled_back'" (click)="rollback(view.batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(460px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:580px; } .batch { min-height:260px; border-bottom:1px solid #dde7e8; padding:14px 4px; display:grid; gap:10px; align-content:start }
    .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .pause-reason { background:#fdece8; color:#b3261e; border:1px solid #f3c1b8; border-radius:6px; padding:6px 10px; font-size:13px }
    .waves { display:grid; grid-template-columns:1fr 1fr; gap:10px } .wave { border:1px solid #d9e4e6; border-radius:8px; padding:8px 10px; background:#f7fafb }
    .wave-head { display:flex; justify-content:space-between; align-items:center; gap:8px } .wave-head span { font-weight:600 }
    .metrics .over { color:#b3261e; font-weight:600 }
    .reconcile { font-size:12px; color:#7a5b00; background:#fff8e1; border:1px solid #f0dfa0; border-radius:6px; padding:6px 10px; display:flex; flex-wrap:wrap; gap:6px }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:460px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly views$ = this.store.select(selectBatchViews);
  readonly audits$ = this.store.select(selectAudits);
  readonly paused$ = this.store.select(selectPausedCount);
  readonly unverified$ = this.store.select(selectUnverifiedTotal);
  private timer?: number;
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  statusText(status: BatchStatus) { return STATUS_TEXT[status]; }
  waveText(status: WaveStatus) { return WAVE_TEXT[status]; }
  rate(view: BatchView) { return view.stats.confirmed ? view.stats.failureRate.toFixed(1) : '—'; }
  isOver(view: BatchView) { return view.stats.confirmed > 0 && view.stats.failureRate > view.batch.failureThreshold; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    this.store.dispatch(createBatch({ draft: { ...this.draft, rolloutPercent: Number(this.draft.rolloutPercent), failureThreshold: Number(this.draft.failureThreshold) } }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  retryPending(view: BatchView) {
    for (const gw of view.batch.gateways.filter((item) => item.state === 'retry_pending')) {
      this.store.dispatch(retryPendingReport({ batchId: view.batch.id, gatewayId: gw.id }));
    }
  }
}
