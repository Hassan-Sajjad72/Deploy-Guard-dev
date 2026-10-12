export function dashboardScopeMatches({project},scope){
  return (!scope.organizationId||project.organizationId===scope.organizationId)&&(!scope.environment||project.environmentName===scope.environment)&&(!scope.clientId||project.clientId===scope.clientId)&&(!scope.engagementId||project.engagementId===scope.engagementId);
}
export function dashboardEvidence({currentState,attention}){
  const authority=currentState?.stateAuthority,release=currentState?.stableRelease,observed=authority?.applicationHealth?.status;
  const health=["healthy","failed","pending"].includes(observed)?observed:"unavailable";
  const releaseVerified=Boolean(release&&/^[a-f0-9]{40}$/i.test(release.commit||"")&&release.generationId&&Number.isFinite(Date.parse(release.promotedAt))&&authority?.runtime?.state==="present"&&["verified_release","aws_observation"].includes(authority.runtime.source));
  return {health,release,releaseVerified,alert:Boolean(attention||health==="failed"||authority?.state==="FAILED"||authority?.latestCompletedOperation?.outcome==="failed")};
}
export function dashboardTotals(rows){
  const totals={projects:rows.length,environments:new Set(rows.map(({project})=>project.environmentName).filter(Boolean)).size,verifiedReleases:0,healthy:0,failedHealth:0,pendingHealth:0,unverifiedHealth:0,alerts:0};
  for(const row of rows){const evidence=dashboardEvidence(row);totals.verifiedReleases+=Number(evidence.releaseVerified);totals.alerts+=Number(evidence.alert);totals[evidence.health==="healthy"?"healthy":evidence.health==="failed"?"failedHealth":evidence.health==="pending"?"pendingHealth":"unverifiedHealth"]++;}
  return totals;
}
