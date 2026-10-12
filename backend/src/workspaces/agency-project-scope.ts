import { BadRequestException, ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";

export async function validateAgencyProjectScope(manager: EntityManager, organizationId: string,
  scope: { clientId?: string | null; engagementId?: string | null; awsAccountBindingId?: string | null }, requireAgencyPair = false) {
  const [organization] = await manager.query(`SELECT kind, archived_at FROM organizations WHERE id = $1 FOR SHARE`, [organizationId]);
  if (!organization) throw new BadRequestException("Workspace not found.");
  if (organization.archived_at) throw new ConflictException("Archived workspaces cannot authorize new projects or deployment plans.");
  if (!scope.clientId && !scope.engagementId) {
    if (requireAgencyPair && organization.kind === "agency") throw new BadRequestException("Select a client and engagement for an agency project.");
    return null;
  }
  if (organization.kind !== "agency" || !scope.clientId || !scope.engagementId) throw new BadRequestException("Client and engagement must belong to an agency workspace and be selected together.");
  const [engagement] = await manager.query(`SELECT engagement.aws_account_binding_id AS "awsAccountBindingId", engagement.archived_at, client.archived_at AS client_archived_at
    FROM agency_engagements engagement JOIN agency_clients client ON client.id = engagement.client_id AND client.organization_id = engagement.organization_id
    WHERE engagement.id = $1 AND engagement.client_id = $2 AND engagement.organization_id = $3 FOR SHARE OF engagement, client`, [scope.engagementId, scope.clientId, organizationId]);
  if (!engagement) throw new BadRequestException("Client engagement not found in this workspace.");
  if (engagement.archived_at || engagement.client_archived_at) throw new ConflictException("Archived clients and engagements cannot authorize new project plans.");
  if (scope.awsAccountBindingId && scope.awsAccountBindingId !== engagement.awsAccountBindingId) throw new BadRequestException("AWS binding does not match the client-authorized engagement.");
  return engagement.awsAccountBindingId as string;
}
