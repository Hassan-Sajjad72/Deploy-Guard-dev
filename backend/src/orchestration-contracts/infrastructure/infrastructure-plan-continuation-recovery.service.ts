import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CrossLaneOwnershipEnforcementService } from "../release-lane/cross-lane-ownership-enforcement.service";
import { InfrastructurePlanCompletionContinuationService } from "./infrastructure-plan-completion-continuation.service";

/**
 * Narrow repair for a plan saved before the additive plan_completed constraint
 * was installed. It never republishes or replans; it preserves the failed
 * parent and creates only its deterministic approval-required child.
 */
@Injectable()
export class InfrastructurePlanContinuationRecoveryService {
  constructor(private readonly dataSource: DataSource, private readonly crossLane: CrossLaneOwnershipEnforcementService, private readonly continuation: InfrastructurePlanCompletionContinuationService) {}

  async recover(parentIntentId: string, workerId = "normal-v1:infrastructure-plan-recovery") {
    const evidence = await this.dataSource.transaction("SERIALIZABLE", async manager => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:infrastructure-plan-recovery:${parentIntentId}`]);
      const rows = await manager.query(`SELECT i.id, i.project_id AS "projectId", i.environment_name AS "environmentName", i.canonical_idempotency_key AS "canonicalKey", i.request_fingerprint AS "requestFingerprint", i.infrastructure_manifest_id AS "manifestId", i.status, i.failure_code AS "failureCode", m.plan_artifact_sha256 AS "planHash", m.plan_input_fingerprint AS "planFingerprint", d.id AS "draftId", o.id AS "outboxId" FROM deployment_intents i JOIN infrastructure_manifests m ON m.id=i.infrastructure_manifest_id JOIN initial_release_drafts d ON d.intent_id=i.id JOIN orchestration_outbox o ON o.intent_id=i.id AND o.event_type='intent.infrastructure.plan' WHERE i.id=$1 FOR UPDATE`, [parentIntentId]);
      const x=rows[0];
      if (!x || x.status !== "failed" || x.failureCode !== "INFRASTRUCTURE_PLAN_CONTINUATION_FAILED" || !x.planHash || !x.planFingerprint) throw new Error("INFRASTRUCTURE_PLAN_CONTINUATION_RECOVERY_INELIGIBLE");
      const active=await manager.query(`SELECT 1 FROM project_operation_leases WHERE project_id=$1 AND environment_name=$2 AND status IN ('acquired','heartbeat_active') AND expires_at>clock_timestamp() UNION ALL SELECT 1 FROM project_release_lane_ownerships WHERE project_id=$1 AND environment_name=$2 AND status IN ('acquired','heartbeat_active') AND expires_at>clock_timestamp()`,[x.projectId,x.environmentName]);
      const children=await manager.query(`SELECT 1 FROM deployment_intents WHERE request_payload->>'parentPlanIntentId'=$1`,[x.id]);
      if (active.length || children.length) throw new Error("INFRASTRUCTURE_PLAN_CONTINUATION_RECOVERY_CONFLICT");
      return x;
    });
    const claim=await this.crossLane.acquireV1({projectId:evidence.projectId,environmentName:evidence.environmentName,intentId:evidence.id,operationId:deterministicUuid(`plan-continuation-recovery:${evidence.id}`),actorId:workerId,requestFingerprint:evidence.requestFingerprint,leaseTtlMs:60_000});
    if (!claim.enabled) throw new Error("INFRASTRUCTURE_PLAN_CONTINUATION_RECOVERY_OWNERSHIP_UNAVAILABLE");
    const leaseId=randomUUID(); let token="";
    try {
      token=await this.dataSource.transaction("SERIALIZABLE",async manager=>{const r=await manager.query(`SELECT COALESCE(MAX(fencing_token),0)::bigint+1 AS token FROM project_operation_leases WHERE project_id=$1 AND environment_name=$2`,[evidence.projectId,evidence.environmentName]); const t=String(r[0].token); await manager.query(`INSERT INTO project_operation_leases (id,project_id,environment_name,lane,scope,intent_id,owner_worker_id,fencing_token,status,acquired_at,heartbeat_at,expires_at,metadata,created_at,updated_at) VALUES ($1,$2,$3,'infrastructure','plan',$4,$5,$6::bigint,'acquired',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '60 seconds',$7::jsonb,clock_timestamp(),clock_timestamp())`,[leaseId,evidence.projectId,evidence.environmentName,evidence.id,workerId,t,JSON.stringify({recovery:true,messageType:"intent.infrastructure.plan"})]); return t;});
      await this.crossLane.attachV1OperationLease(claim,{intentId:evidence.id,operationLeaseId:leaseId,operationWorkerId:workerId,operationFencingToken:token});
      return await this.continuation.complete({parentIntentId:evidence.id,parentCanonicalIdempotencyKey:evidence.canonicalKey,parentRequestFingerprint:evidence.requestFingerprint,infrastructureManifestId:evidence.manifestId,initialReleaseDraftId:evidence.draftId,planOutboxId:evidence.outboxId,planArtifactSha256:evidence.planHash,planInputFingerprint:evidence.planFingerprint,operationLeaseId:leaseId,operationWorkerId:workerId,operationFencingToken:token,ownershipLeaseId:claim.fence.ownershipLeaseId,ownershipActorId:claim.fence.actorId,ownershipFencingToken:claim.fence.ownershipFencingToken,terminalRecovery:true});
    } catch (error) { await this.crossLane.releaseV1(claim,{intentId:evidence.id,operationLeaseId:leaseId}); throw error; }
  }
}

function deterministicUuid(seed: string) {
  const hex=createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
