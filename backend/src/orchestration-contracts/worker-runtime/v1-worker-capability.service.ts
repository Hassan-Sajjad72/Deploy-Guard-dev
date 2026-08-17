import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { WorkerMessageType } from "../contracts/worker-envelope.types";
import { workerRoleForMessageType } from "../outbox/outbox-dispatcher.pure";
import {
  ExecutableV1MessageType,
  InactiveV1WorkerRuntimeError,
  V1WorkerCapabilityIdentity,
  V1WorkerCapabilitySnapshot,
  V1WorkerHeartbeatSession,
} from "./inactive-v1-worker-runtime.types";
import { canonicalizeV1WorkerCapability } from "./v1-worker-capability.pure";

type CapabilityRow = {
  workerId: string;
  role: V1WorkerCapabilitySnapshot["role"];
  minimumProtocol: number;
  maximumProtocol: number;
  supportedMessageTypes: ExecutableV1MessageType[];
  serviceVersion: string;
  gitSha: string;
  startedAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  metadata: Record<string, unknown>;
};

@Injectable()
export class V1WorkerCapabilityService {
  constructor(private readonly dataSource: DataSource) {}

  async register(
    input: V1WorkerCapabilityIdentity,
  ): Promise<V1WorkerCapabilitySnapshot> {
    let capability: V1WorkerCapabilityIdentity;
    try {
      capability = canonicalizeV1WorkerCapability(input);
    } catch {
      throw new InactiveV1WorkerRuntimeError("WORKER_CAPABILITY_INVALID");
    }
    const rows = this.rows<CapabilityRow>(await this.dataSource.query(
      `INSERT INTO worker_capabilities (
         worker_id, role, minimum_protocol, maximum_protocol,
         supported_message_types, service_version, git_sha,
         started_at, heartbeat_at, expires_at, metadata, updated_at
       )
       VALUES (
         $1, $2, 1, 1, $3::jsonb, $4, $5,
         clock_timestamp(), clock_timestamp(),
         clock_timestamp() + ($6::bigint * interval '1 millisecond'),
         $7::jsonb, clock_timestamp()
       )
       ON CONFLICT (worker_id) DO UPDATE SET
         role = EXCLUDED.role,
         minimum_protocol = 1,
         maximum_protocol = 1,
         supported_message_types = EXCLUDED.supported_message_types,
         service_version = EXCLUDED.service_version,
         git_sha = EXCLUDED.git_sha,
         started_at = clock_timestamp(),
         heartbeat_at = clock_timestamp(),
         expires_at = clock_timestamp() + ($6::bigint * interval '1 millisecond'),
         metadata = EXCLUDED.metadata,
         updated_at = clock_timestamp()
       RETURNING
         worker_id AS "workerId", role,
         minimum_protocol AS "minimumProtocol",
         maximum_protocol AS "maximumProtocol",
         supported_message_types AS "supportedMessageTypes",
         service_version AS "serviceVersion", git_sha AS "gitSha",
         started_at AS "startedAt", heartbeat_at AS "heartbeatAt",
         expires_at AS "expiresAt", metadata`,
      [
        capability.workerId,
        capability.role,
        JSON.stringify(capability.supportedMessageTypes),
        capability.serviceVersion,
        capability.gitSha,
        capability.heartbeatTtlMs,
        JSON.stringify(capability.metadata),
      ],
    ));
    if (rows.length !== 1) {
      throw new InactiveV1WorkerRuntimeError("WORKER_CAPABILITY_INVALID");
    }
    return this.snapshot(rows[0]);
  }

  async heartbeat(
    input: V1WorkerCapabilityIdentity,
  ): Promise<V1WorkerCapabilitySnapshot | null> {
    let capability: V1WorkerCapabilityIdentity;
    try {
      capability = canonicalizeV1WorkerCapability(input);
    } catch {
      throw new InactiveV1WorkerRuntimeError("WORKER_CAPABILITY_INVALID");
    }
    const rows = this.rows<CapabilityRow>(await this.dataSource.query(
      `UPDATE worker_capabilities
       SET heartbeat_at = clock_timestamp(),
           expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
       WHERE worker_id = $1
         AND role = $2
         AND minimum_protocol = 1
         AND maximum_protocol = 1
         AND supported_message_types = $3::jsonb
         AND service_version = $4
         AND git_sha = $5
         AND metadata = $6::jsonb
         AND expires_at > clock_timestamp()
       RETURNING
         worker_id AS "workerId", role,
         minimum_protocol AS "minimumProtocol",
         maximum_protocol AS "maximumProtocol",
         supported_message_types AS "supportedMessageTypes",
         service_version AS "serviceVersion", git_sha AS "gitSha",
         started_at AS "startedAt", heartbeat_at AS "heartbeatAt",
         expires_at AS "expiresAt", metadata`,
      [
        capability.workerId,
        capability.role,
        JSON.stringify(capability.supportedMessageTypes),
        capability.serviceVersion,
        capability.gitSha,
        JSON.stringify(capability.metadata),
        capability.heartbeatTtlMs,
      ],
    ));
    return rows.length === 1 ? this.snapshot(rows[0]) : null;
  }

  async startHeartbeatSession(
    input: V1WorkerCapabilityIdentity,
    heartbeatIntervalMs = Math.max(
      250,
      Math.floor(input.heartbeatTtlMs / 3),
    ),
  ): Promise<V1WorkerHeartbeatSession> {
    let capability: V1WorkerCapabilityIdentity;
    try {
      capability = canonicalizeV1WorkerCapability(input);
    } catch {
      throw new InactiveV1WorkerRuntimeError("WORKER_CAPABILITY_INVALID");
    }
    if (
      !Number.isInteger(heartbeatIntervalMs)
      || heartbeatIntervalMs < 100
      || heartbeatIntervalMs >= capability.heartbeatTtlMs
    ) {
      throw new InactiveV1WorkerRuntimeError("WORKER_CAPABILITY_INVALID");
    }
    await this.register(capability);

    let active = true;
    let failure: "CAPABILITY_EXPIRED" | "HEARTBEAT_FAILED" | null = null;
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> = Promise.resolve();
    const schedule = () => {
      if (!active) return;
      timer = setTimeout(() => {
        inFlight = this.heartbeat(capability)
          .then((renewed) => {
            if (!renewed) {
              failure = "CAPABILITY_EXPIRED";
              active = false;
            } else {
              failure = null;
            }
          })
          .catch(() => {
            failure = "HEARTBEAT_FAILED";
          })
          .finally(schedule);
      }, heartbeatIntervalMs);
      timer.unref();
    };
    schedule();

    return Object.freeze({
      workerId: capability.workerId,
      isActive: () => active,
      lastFailureCode: () => failure,
      stop: async () => {
        active = false;
        if (timer) clearTimeout(timer);
        await inFlight;
      },
    });
  }

  async requireLiveCompatible(
    workerId: string,
    messageType: WorkerMessageType,
  ): Promise<V1WorkerCapabilitySnapshot> {
    const role = workerRoleForMessageType(messageType);
    const rows = this.rows<CapabilityRow>(await this.dataSource.query(
      `SELECT
         worker_id AS "workerId", role,
         minimum_protocol AS "minimumProtocol",
         maximum_protocol AS "maximumProtocol",
         supported_message_types AS "supportedMessageTypes",
         service_version AS "serviceVersion", git_sha AS "gitSha",
         started_at AS "startedAt", heartbeat_at AS "heartbeatAt",
         expires_at AS "expiresAt", metadata
       FROM worker_capabilities
       WHERE worker_id = $1
         AND role = $2
         AND expires_at > clock_timestamp()
         AND minimum_protocol <= 1
         AND maximum_protocol >= 1
         AND supported_message_types @> $3::jsonb
       LIMIT 1`,
      [workerId, role, JSON.stringify([messageType])],
    ));
    if (rows.length !== 1) {
      throw new InactiveV1WorkerRuntimeError(
        "WORKER_CAPABILITY_UNAVAILABLE",
      );
    }
    return this.snapshot(rows[0]);
  }

  private snapshot(row: CapabilityRow): V1WorkerCapabilitySnapshot {
    return {
      ...row,
      minimumProtocol: 1,
      maximumProtocol: 1,
      startedAt: new Date(row.startedAt),
      heartbeatAt: new Date(row.heartbeatAt),
      expiresAt: new Date(row.expiresAt),
    };
  }

  private rows<T>(result: unknown): T[] {
    if (
      Array.isArray(result)
      && result.length === 2
      && Array.isArray(result[0])
      && typeof result[1] === "number"
    ) {
      return result[0] as T[];
    }
    return Array.isArray(result) ? result as T[] : [];
  }
}
