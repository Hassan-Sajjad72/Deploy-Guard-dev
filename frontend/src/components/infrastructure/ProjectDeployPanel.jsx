import { useEffect, useState } from "react";
import {
  deployProject,
  getDeploymentReadiness,
  getInfrastructure,
  getInfrastructureEvents,
  getServiceDiscovery,
} from "../../api/projectApi.js";
import ErrorState from "../common/ErrorState.jsx";
import DeployButton from "./DeployButton.jsx";
import DeploymentReadinessChecklist from "./DeploymentReadinessChecklist.jsx";
import InfrastructureEventsTimeline from "./InfrastructureEventsTimeline.jsx";
import InfrastructureStatusCard from "./InfrastructureStatusCard.jsx";
import ServiceDiscoveryCard from "./ServiceDiscoveryCard.jsx";

const ACTIVE_INFRA_STATUSES = ["queued", "planning", "provisioning"];

export default function ProjectDeployPanel({ allowManualDeploy = false, canManage, onDeploymentQueued, projectId }) {
  const [readiness, setReadiness] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [events, setEvents] = useState([]);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [isDeploying, setIsDeploying] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    load();
  }, [projectId]);

  useEffect(() => {
    if (!environment || !ACTIVE_INFRA_STATUSES.includes(environment.status)) {
      return undefined;
    }

    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, [environment?.status, projectId]);

  async function load() {
    setError("");

    try {
      const [readinessResponse, infrastructureResponse, eventsResponse, discoveryResponse] =
        await Promise.all([
          getDeploymentReadiness(projectId),
          getInfrastructure(projectId),
          getInfrastructureEvents(projectId),
          getServiceDiscovery(projectId),
        ]);
      setReadiness(readinessResponse);
      setEnvironment(infrastructureResponse.environment);
      setEvents(eventsResponse.events || []);
      setRecords(discoveryResponse.records || []);
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function loadStatus() {
    try {
      const [infrastructureResponse, eventsResponse, discoveryResponse] = await Promise.all([
        getInfrastructure(projectId),
        getInfrastructureEvents(projectId),
        getServiceDiscovery(projectId),
      ]);
      setEnvironment(infrastructureResponse.environment);
      setEvents(eventsResponse.events || []);
      setRecords(discoveryResponse.records || []);
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function deploy() {
    setError("");
    setIsDeploying(true);
    setShowConfirm(false);

    try {
      const response = await deployProject(projectId);
      await load();
      onDeploymentQueued?.(response.pipelineRunId);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsDeploying(false);
    }
  }

  return (
    <div className="grid">
      {error ? <ErrorState message={error} /> : null}
      {allowManualDeploy ? <section className="panel">
        <div className="page-header">
          <div>
            <h2>Deploy to AWS</h2>
            <p className="muted">
              Terraform apply creates AWS resources and may incur charges.
            </p>
          </div>
          <DeployButton
            canManage={canManage}
            isDeploying={isDeploying}
            onDeploy={() => setShowConfirm(true)}
            readiness={readiness}
          />
        </div>
        {showConfirm ? (
          <div className="state">
            <p>
              This will create AWS resources and may incur charges. NAT Gateway has
              hourly cost and destroy is not available until module 6.15.
            </p>
            <div className="quick-actions">
              <button className="button" disabled={isDeploying} onClick={deploy} type="button">
                Confirm Deploy to AWS
              </button>
              <button
                className="secondary-button"
                onClick={() => setShowConfirm(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section> : null}
      <DeploymentReadinessChecklist readiness={readiness} />
      <InfrastructureStatusCard environment={environment} />
      <ServiceDiscoveryCard records={records} />
      <InfrastructureEventsTimeline events={events} />
    </div>
  );
}
