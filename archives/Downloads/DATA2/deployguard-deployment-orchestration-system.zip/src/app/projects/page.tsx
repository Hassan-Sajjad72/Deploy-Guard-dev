import Link from "next/link";
import {
  FolderKanban,
  PlusCircle,
  Globe,
  GitBranch,
  Clock,
  MoreVertical,
} from "lucide-react";
import { mockProjects, mockDeployments } from "@/lib/mock-data";

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-accent-cyan/15 text-accent-cyan",
    deploying: "bg-accent-blue/15 text-accent-blue animate-pulse-dot",
    failed: "bg-accent-red/15 text-accent-red",
    idle: "bg-deployguard-500/20 text-deployguard-400",
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-deployguard-600/20 text-deployguard-300"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function ProjectsPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Manage your deployed applications and workspaces
          </p>
        </div>
        <Link
          href="/projects/new"
          className="flex items-center gap-2 bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 px-4 py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <PlusCircle className="w-4 h-4" />
          New Project
        </Link>
      </div>

      {/* Projects Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {mockProjects.map((project) => {
          const projectDeployments = mockDeployments.filter(
            (d) => d.projectId === project.id
          );
          const lastDeployment = projectDeployments[0];

          return (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="group bg-deployguard-900 border border-border rounded-xl p-5 hover:border-accent-cyan/30 hover:glow-cyan transition-all duration-300"
            >
              {/* Project Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-accent-cyan/20 to-accent-blue/20 flex items-center justify-center">
                    <FolderKanban className="w-5 h-5 text-accent-cyan" />
                  </div>
                  <div>
                    <h3 className="font-semibold group-hover:text-accent-cyan transition-colors">
                      {project.name}
                    </h3>
                    <StatusBadge status={project.status} />
                  </div>
                </div>
                <span className="text-deployguard-500 hover:text-white transition-colors p-1">
                  <MoreVertical className="w-4 h-4" />
                </span>
              </div>

              {/* Stack Info */}
              <div className="bg-deployguard-800/50 rounded-lg p-3 mb-4">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-deployguard-500">Framework</span>
                    <p className="text-deployguard-200 font-medium mt-0.5">
                      {project.detectedStack.framework}
                    </p>
                  </div>
                  <div>
                    <span className="text-deployguard-500">Runtime</span>
                    <p className="text-deployguard-200 font-medium mt-0.5">
                      {project.detectedStack.language}
                    </p>
                  </div>
                  <div>
                    <span className="text-deployguard-500">Port</span>
                    <p className="text-deployguard-200 font-medium mt-0.5">
                      {project.detectedStack.port}
                    </p>
                  </div>
                  <div>
                    <span className="text-deployguard-500">Region</span>
                    <p className="text-deployguard-200 font-medium mt-0.5">
                      {project.awsRegion}
                    </p>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between text-xs text-deployguard-400">
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3 h-3" />
                  <span>{project.branch}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3" />
                  <span>{new Date(project.lastDeployed).toLocaleDateString()}</span>
                </div>
              </div>

              {/* Last Deployment */}
              {lastDeployment && (
                <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs">
                    <code className="bg-deployguard-800 px-1.5 py-0.5 rounded text-accent-blue">
                      {lastDeployment.commitHash}
                    </code>
                    <span className="text-deployguard-400 truncate max-w-[120px]">
                      {lastDeployment.commitMessage}
                    </span>
                  </div>
                  <span className="text-xs text-deployguard-400">
                    {lastDeployment.estimatedCost}
                  </span>
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
