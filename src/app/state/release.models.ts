export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/**
 * 单条网关安装结果状态：
 * - pending              待回来（离线 / 在途，尚无结果，不计入失败率分母）
 * - succeeded            已更新成功
 * - failed               失败，保留待重试
 * - pending_verification 批次结束仍未回来，留成待核对
 */
export type GatewayResultStatus = 'pending' | 'succeeded' | 'failed' | 'pending_verification';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

/**
 * 单条网关安装结果。同一条安装结果重传只算一次：
 * 统计始终由各网关状态聚合而成，重传仅累加 attempts、刷新 reportedAt，不重复计数。
 */
export interface GatewayInstall {
  gatewayId: string;
  /** 所属波次，0 起 */
  wave: number;
  /** 该网关是否会在批次窗口内回网（false = 离线，回网后合并结果） */
  online: boolean;
  status: GatewayResultStatus;
  /** 上报/重试次数（重传不重复计数，仅用于审计展示） */
  attempts: number;
  /** 去重键：gatewayId|firmware|installId，同一条安装结果重传只算一次 */
  resultKey: string;
  /** 首次上报时间 */
  reportedAt: string | null;
  /** 最近一次上报时间 */
  lastReportedAt: string | null;
  /** 批次结束后才到的结果：只进对账，不再把状态翻回发布中 */
  reconciled: boolean;
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
  progress: number;
  /** 已更新成功（succeeded） */
  downloaded: number;
  /** 失败待重试（failed） */
  failed: number;
  /** 待核对（pending_verification，批次结束未回来） */
  pendingVerification: number;
  /** 待回来（pending，离线/在途，不计入失败率分母） */
  pendingOffline: number;
  /** 失败率 = failed / (succeeded + failed)，分母不含离线待回来 */
  failureRate: number;
  /** 波次总数 */
  waveCount: number;
  /** 当前波次，0 起；-1 表示尚未开始发布 */
  activeWave: number;
  /** 自动暂停原因（手动暂停为 null） */
  pausedReason: string | null;
  /** 网关级安装结果，波次拆分与去重的依据 */
  gateways: GatewayInstall[];
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  /** 数据形状版本，用于旧数据升级迁移 */
  version: number;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
}
