import { useEffect, useState } from "react";
import {
  getDeploymentReadiness,
  getInfrastructure,
  getInfrastructureEvents,
  getServiceDiscovery,
} from "../../api/projectApi.js";
import ErrorState from "../common/ErrorState.jsx";
import DeploymentReadinessChecklist from "./DeploymentReadinessChecklist.jsx";
import InfrastructureEventsTimeline from "./InfrastructureEventsTimeline.jsx";
import InfrastructureStatusCard from "./InfrastructureStatusCard.jsx";
import ServiceDiscoveryCard from "./ServiceDiscoveryCard.jsx";

const ACTIVE_INFRA_STATUSES = ["queued", "planning", "provisioning"];

export default function ProjectDeployPanel({ projectId }) {
  const [readiness, setReadiness] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [events, setEvents] = useState([]);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");

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

  return (
    <div className="grid">
      {error ? <ErrorState message={error} /> : null}
      <DeploymentReadinessChecklist readiness={readiness} />
      <InfrastructureStatusCard environment={environment} />
      <ServiceDiscoveryCard records={records} />
      <InfrastructureEventsTimeline events={events} />
    </div>
  );
}
