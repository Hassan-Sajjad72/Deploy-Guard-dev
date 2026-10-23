import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  archiveProject,
  getProject,
  getProjectBranches,
  updateProject,
  updateProjectBranch,
  updateProjectRepository,
} from "../api/projectApi.js";
import BranchSelector from "../components/projects/BranchSelector.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import ProjectSettingsForm from "../components/projects/ProjectSettingsForm.jsx";

export default function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    description: "",
    visibility: "private",
    repositoryUrl: "",
    targetBranch: "main",
  });
  const [branches, setBranches] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    async function loadProject() {
      setError("");
      setIsLoading(true);

      try {
        const response = await getProject(projectId);
        const project = response.project;
        setForm({
          name: project.name || "",
          description: project.description || "",
          visibility: project.visibility || "private",
          repositoryUrl: project.repositoryUrl || "",
          targetBranch: project.targetBranch || "main",
        });
        setCanManage(Boolean(project.canManage));
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setIsLoading(false);
      }
    }

    loadProject();
  }, [projectId]);

  function updateField(event) {
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
  }

  async function saveProject(event) {
    event.preventDefault();
    await runAction(async () => {
      await updateProject(projectId, {
        name: form.name,
        description: form.description,
        visibility: form.visibility,
      });
      setSuccess("Project updated.");
    });
  }

  async function saveRepository(event) {
    event.preventDefault();
    await runAction(async () => {
      await updateProjectRepository(projectId, {
        repositoryUrl: form.repositoryUrl,
      });
      setSuccess("Repository updated.");
    });
  }

  async function fetchBranches() {
    await runAction(async () => {
      const response = await getProjectBranches(projectId);
      setBranches(response.branches || []);
      setSuccess("Branches loaded.");
    });
  }

  async function saveBranch() {
    await runAction(async () => {
      await updateProjectBranch(projectId, form.targetBranch);
      setSuccess("Branch updated.");
    });
  }

  async function archiveCurrentProject() {
    if (!window.confirm("Archive this project?")) {
      return;
    }

    await runAction(async () => {
      await archiveProject(projectId);
      navigate("/projects");
    });
  }

  async function runAction(action) {
    setError("");
    setSuccess("");
    setIsSubmitting(true);

    try {
      await action();
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading settings..." />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Project Settings</h1>
          <p className="muted">
            {canManage ? "Update repository and branch settings." : "View-only mode."}
          </p>
        </div>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {success ? <div className="state success">{success}</div> : null}
      <ProjectSettingsForm
        disabled={!canManage}
        form={form}
        isSubmitting={isSubmitting}
        onArchive={archiveCurrentProject}
        onChange={updateField}
        onSaveProject={saveProject}
        onSaveRepository={saveRepository}
      />
      <BranchSelector
        branches={branches}
        disabled={!canManage || isSubmitting}
        onFetch={fetchBranches}
        onSave={saveBranch}
        onSelect={(targetBranch) =>
          setForm((current) => ({ ...current, targetBranch }))
        }
        selectedBranch={form.targetBranch}
      />
    </div>
  );
}
