export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

export type InstallOutcome = 'succeeded' | 'failed';

/**
 * 网关安装任务状态：
 * - waiting：已排入波次，尚未派发（后波在线网关初始态）
 * - offline：网关离线，暂不派发，也不计入失败率分母；回网后再派发
 * - dispatched：已派发，等待安装结果
 * - retry_pending：安装结果已产生但上报失败，报文保留待重试，未确认前不计入分母
 * - succeeded/failed：已确认的最终结果
 * - unverified：超过宽限期一直没回来，列为待核对（关闭波次用，不算真失败）
 */
export type GatewayState =
  | 'waiting'
  | 'offline'
  | 'dispatched'
  | 'retry_pending'
  | 'succeeded'
  | 'failed'
  | 'unverified';

export type WaveStatus = 'pending' | 'running' | 'finalized';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface GatewayTask {
  id: string;
  waveIndex: number;
  state: GatewayState;
  /** 安装结果唯一标识，同一条结果重传凭此去重，只计一次 */
  resultId?: string;
  /** 上报失败时保留的结果内容，供待重试使用 */
  pendingOutcome?: InstallOutcome;
  retryAttempts: number;
  /** 模拟派发后结果预计到达的 tick */
  dueTick?: number;
  reportedAt?: string;
  /** 模拟重传只发一次 */
  resent?: boolean;
  /** 批次结束后才回网/回报，结果已登记到对账 */
  reconciledAt?: string;
}

export interface ReleaseWave {
  index: number;
  status: WaveStatus;
  /** 本波分配的网关总数（含离线） */
  total: number;
  startedAt?: string;
  finalizedAt?: string;
  /** 超过该 tick 仍未回报的网关转待核对 */
  closeAfterTick?: number;
}

/** 批次结束后才到达的安装结果只进对账，不回翻批次状态 */
export interface ReconcileEntry {
  resultId: string;
  gatewayId: string;
  waveIndex: number;
  outcome: InstallOutcome;
  receivedAt: string;
  note: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  updatedAt: string;
  // ---- 波次与逐网关结果 ----
  waves: ReleaseWave[];
  gateways: GatewayTask[];
  activeWave: number | null;
  /** 遥测 tick 计数，驱动模拟超时 */
  tick: number;
  /** 暂停原因：失败率超阈值自动暂停 / 手动暂停 / 旧数据升级 */
  pauseReason?: string;
  /** 批次结束后到达的结果，仅用于对账 */
  reconcile: ReconcileEntry[];
  /** 已入账的结果 ID，重传去重 */
  resultIds: string[];
  // ---- 旧版（v1）字段，迁移后保留兜底展示 ----
  progress?: number;
  downloaded?: number;
  failed?: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  version: 2;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
}
