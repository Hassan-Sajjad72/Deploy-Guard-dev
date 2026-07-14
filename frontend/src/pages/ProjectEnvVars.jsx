import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  createProjectEnvVar,
  deleteProjectEnvVar,
  getProject,
  getProjectEnvVars,
  updateProjectEnvVar,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import EnvVarForm from "../components/projects/EnvVarForm.jsx";
import EnvVarTable from "../components/projects/EnvVarTable.jsx";

const emptyForm = { id: "", key: "", value: "", isSecret: true };

export default function ProjectEnvVars() {
  const { projectId } = useParams();
  const [variables, setVariables] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    loadEnvVars();
  }, [projectId]);

  async function loadEnvVars() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, envResponse] = await Promise.all([
        getProject(projectId),
        getProjectEnvVars(projectId),
      ]);
      setCanManage(Boolean(projectResponse.project.canManage));
      setVariables(envResponse.variables || []);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  function updateField(event) {
    const { checked, name, type, value } = event.target;
    setForm((current) => ({
      ...current,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function submitForm(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setIsSubmitting(true);

    try {
      if (form.id) {
        const response = await updateProjectEnvVar(projectId, form.id, {
          key: form.key,
          value: form.value || undefined,
          isSecret: form.isSecret,
        });
        setVariables((current) =>
          current.map((variable) =>
            variable.id === form.id ? response.variable : variable
          )
        );
        setSuccess("Environment variable updated.");
      } else {
        const response = await createProjectEnvVar(projectId, {
          key: form.key,
          value: form.value,
          isSecret: form.isSecret,
        });
        setVariables((current) => [...current, response.variable]);
        setSuccess("Environment variable added.");
      }

      setForm(emptyForm);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteVariable(envId) {
    if (!window.confirm("Delete this environment variable?")) {
      return;
    }

    setError("");
    setSuccess("");

    try {
      await deleteProjectEnvVar(projectId, envId);
      setVariables((current) => current.filter((variable) => variable.id !== envId));
      setSuccess("Environment variable deleted.");
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  function editVariable(variable) {
    setForm({
      id: variable.id,
      key: variable.key,
      value: "",
      isSecret: variable.isSecret,
    });
  }

  if (isLoading) {
    return <LoadingState message="Loading environment variables..." />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Environment Variables</h1>
          <p className="muted">Values are masked after save.</p>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {success ? <div className="state success">{success}</div> : null}
      {canManage ? (
        <EnvVarForm
          form={form}
          isSubmitting={isSubmitting}
          onCancel={form.id ? () => setForm(emptyForm) : null}
          onChange={updateField}
          onSubmit={submitForm}
          submitLabel={form.id ? "Update variable" : "Add variable"}
        />
      ) : null}
      {variables.length === 0 ? (
        <EmptyState message="No environment variables found." />
      ) : (
        <EnvVarTable
          canManage={canManage}
          onDelete={deleteVariable}
          onEdit={editVariable}
          variables={variables}
        />
      )}
    </div>
  );
}
