import { IsNull } from "typeorm";

export const billingScope = (userId: number, organizationId?: string | null) => organizationId
  ? { organizationId } : { userId, organizationId: IsNull() };
