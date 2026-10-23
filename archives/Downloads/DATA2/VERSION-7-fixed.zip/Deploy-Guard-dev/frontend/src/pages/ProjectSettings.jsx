import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import { PageHeader, ProjectQuickNav } from "../components/common/Premium.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";

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
      setSuccess("Workspace identity updated successfully.");
    });
  }

  async function saveRepository(event) {
    event.preventDefault();
    await runAction(async () => {
      await updateProjectRepository(projectId, {
        repositoryUrl: form.repositoryUrl,
      });
      setSuccess("Repository connection updated. Fetch branches to confirm GitHub access.");
    });
  }

  async function fetchBranches() {
    await runAction(async () => {
      const response = await getProjectBranches(projectId);
      setBranches(response.branches || []);
      setSuccess("Repository branches loaded successfully.");
    });
  }

  async function saveBranch() {
    await runAction(async () => {
      await updateProjectBranch(projectId, form.targetBranch);
      navigate(`/projects/${projectId}`, {
        state: { startAutomation: true },
      });
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
      <PageHeader eyebrow="Project Setup" title="Repository & Workspace Setup" description={canManage ? "Manage only the repository, release branch, visibility, and workspace identity used by later deployment stages." : "Repository and workspace settings are available in view-only mode."} context={`${form.repositoryUrl || "Repository not connected"} · ${form.targetBranch || "No branch selected"}`} />
      <ProjectQuickNav projectId={projectId} />
      <ProjectModuleStatusStrip moduleKey="repository" projectId={projectId} />
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
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Optional External CI</p><h2>GitHub Actions is not required</h2><p className="muted">GitHub Actions workflow is optional. DeployGuard can build and deploy using its internal pipeline.</p></div></div>
        <ul className="setup-checklist"><li>DeployGuard clones the selected branch itself.</li><li>DeployGuard generates a Dockerfile from its detected template when the repository does not provide one.</li><li>No repository Terraform, docker-compose, or AWS credentials are required.</li><li>If you opt into external validation, the workflow must support <code>workflow_dispatch</code> and the backend token needs Actions write permission.</li></ul>
        <Link className="secondary-button" to={`/projects/${projectId}`}>Open Project Overview</Link>
      </section>
    </div>
  );
}
