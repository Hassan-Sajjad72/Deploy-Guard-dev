import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getAuditLogs } from "../api/auditLogApi.js";
import AuditLogFilters from "../components/audit/AuditLogFilters.jsx";
import AuditLogsTable from "../components/audit/AuditLogsTable.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Pagination from "../components/common/Pagination.jsx";
import { BentoGrid, MetricCard, PageHeader } from "../components/common/Premium.jsx";

const defaultFilters = {
  action: "",
  resourceType: "",
  resourceId: "",
  status: "",
  from: "",
  to: "",
  page: 1,
  limit: 20,
};

export default function AuditLogs() {
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    ...defaultFilters,
    resourceType: searchParams.get("resourceType") || "",
    resourceId: searchParams.get("resourceId") || "",
  });
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadLogs() {
      setError("");
      setIsLoading(true);

      try {
        const response = await getAuditLogs(filters);

        if (!isMounted) {
          return;
        }

        setLogs(response?.logs || []);
        setPagination(
          response?.pagination || {
            page: filters.page,
            limit: filters.limit,
            total: 0,
            totalPages: 1,
          }
        );
      } catch (caughtError) {
        if (isMounted) {
          setError(caughtError.message);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadLogs();

    return () => {
      isMounted = false;
    };
  }, [filters]);

  function updatePage(page) {
    setFilters((current) => ({ ...current, page }));
  }

  function updateLimit(limit) {
    setFilters((current) => ({ ...current, limit, page: 1 }));
  }

  return (
    <div className="grid">
      <PageHeader eyebrow="Activity & Audit" title="Platform Activity" description="Review who changed what, which resource was affected, and whether the operation succeeded." context="Sensitive metadata is redacted before it is displayed" />

      <BentoGrid>
        <MetricCard label="Matching Events" value={pagination.total} detail="Events matching the active filters" />
        <MetricCard label="Successful on Page" value={logs.filter((log) => log.status === "success").length} detail="Visible successful operations" tone="success" />
        <MetricCard label="Failed on Page" value={logs.filter((log) => log.status === "failed").length} detail="Visible operations needing review" tone={logs.some((log) => log.status === "failed") ? "danger" : "neutral"} />
      </BentoGrid>

      <section className="panel"><div className="section-heading"><div><p className="eyebrow">Filters</p><h2>Find relevant activity</h2></div></div><AuditLogFilters filters={filters} onChange={setFilters} onReset={() => setFilters(defaultFilters)} embedded /></section>

      {error ? <ErrorState message={error} /> : null}
      {isLoading ? <LoadingState message="Loading audit logs..." /> : null}
      {!isLoading && !error && logs.length === 0 ? (
        <EmptyState message="No audit logs found." />
      ) : null}
      {!isLoading && logs.length > 0 ? <AuditLogsTable logs={logs} /> : null}
      {!isLoading && !error ? (
        <Pagination
          onLimitChange={updateLimit}
          onPageChange={updatePage}
          pagination={pagination}
        />
      ) : null}
    </div>
  );
}
