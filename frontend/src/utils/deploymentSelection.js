export function deploymentSelectionKey(repository, branch) {
  return repository && branch ? `${repository.toLowerCase()}:${branch}` : "";
}

export function createDeploymentSelectionGate() {
  let version = 0;
  let selection = "";
  return {
    select(repository, branch) {
      selection = deploymentSelectionKey(repository, branch);
      version += 1;
      return selection;
    },
    begin(repository, branch) {
      selection = deploymentSelectionKey(repository, branch);
      version += 1;
      return { selection, version };
    },
    isCurrent(ticket) {
      return ticket.selection === selection && ticket.version === version;
    },
  };
}
