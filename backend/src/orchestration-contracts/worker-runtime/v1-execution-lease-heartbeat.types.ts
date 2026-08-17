export type V1ExecutionLeaseHeartbeatDisposition =
  | "active"
  | "stopped"
  | "cancelled"
  | "ownership_lost"
  | "heartbeat_failed";

export type V1ExecutionLeaseHeartbeatFailureCode =
  | "EXECUTION_CANCELLED"
  | "EXECUTION_HEARTBEAT_FAILED"
  | "EXECUTION_OWNERSHIP_LOST";

export type V1ExecutionLeaseHeartbeatSession = {
  readonly signal: AbortSignal;
  isTrusted(): boolean;
  disposition(): V1ExecutionLeaseHeartbeatDisposition;
  lastFailureCode(): V1ExecutionLeaseHeartbeatFailureCode | null;
  stop(): Promise<V1ExecutionLeaseHeartbeatDisposition>;
};
