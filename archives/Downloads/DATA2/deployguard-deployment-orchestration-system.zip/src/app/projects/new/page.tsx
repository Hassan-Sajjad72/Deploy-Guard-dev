"use client";

import { useState } from "react";
import {
  GitBranch,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Settings,
  Rocket,
  Loader2,
  Code2,
} from "lucide-react";
import Link from "next/link";

const steps = [
  { id: 1, label: "Repository", icon: Code2 },
  { id: 2, label: "Configuration", icon: Settings },
  { id: 3, label: "Review & Deploy", icon: Rocket },
];

export default function NewProjectPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState({
    repositoryUrl: "",
    branch: "main",
    projectName: "",
    awsRegion: "us-east-1",
    environmentVars: [{ key: "NODE_ENV", value: "production" }],
  });
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);

  const addEnvVar = () => {
    setFormData((prev) => ({
      ...prev,
      environmentVars: [...prev.environmentVars, { key: "", value: "" }],
    }));
  };

  const removeEnvVar = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      environmentVars: prev.environmentVars.filter((_, i) => i !== index),
    }));
  };

  const updateEnvVar = (index: number, field: "key" | "value", val: string) => {
    setFormData((prev) => ({
      ...prev,
      environmentVars: prev.environmentVars.map((ev, i) =>
        i === index ? { ...ev, [field]: val } : ev
      ),
    }));
  };

  const handleDetect = () => {
    setDetecting(true);
    setTimeout(() => {
      setDetecting(false);
      setDetected(true);
    }, 2500);
  };

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Create New Project</h1>
        <p className="text-deployguard-400 text-sm mt-1">
          Link your GitHub repository and configure your deployment
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-2">
        {steps.map((step, i) => {
          const StepIcon = step.icon;
          const isActive = currentStep === step.id;
          const isCompleted = currentStep > step.id;
          return (
            <div key={step.id} className="flex items-center">
              <button
                onClick={() => step.id < currentStep && setCurrentStep(step.id)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? "bg-accent-cyan/15 text-accent-cyan glow-cyan"
                    : isCompleted
                    ? "bg-accent-cyan/10 text-accent-cyan"
                    : "bg-deployguard-800 text-deployguard-400"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  <StepIcon className="w-4 h-4" />
                )}
                {step.label}
              </button>
              {i < steps.length - 1 && (
                <div className={`w-12 h-0.5 mx-2 ${currentStep > step.id ? "bg-accent-cyan" : "bg-deployguard-700"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="bg-deployguard-900 border border-border rounded-xl p-6">
        {/* Step 1: Repository */}
        {currentStep === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-1">Connect Repository</h2>
              <p className="text-sm text-deployguard-400">
                Enter your GitHub repository URL to get started
              </p>
            </div>

            {/* GitHub OAuth Button */}
            <button className="flex items-center gap-3 bg-white text-gray-900 px-5 py-3 rounded-lg text-sm font-medium hover:bg-gray-100 transition-colors w-full sm:w-auto">
              <Code2 className="w-5 h-5" />
              Connect GitHub Account
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-deployguard-900 px-3 text-deployguard-400">or enter URL manually</span>
              </div>
            </div>

            {/* Repository URL */}
            <div>
              <label className="block text-sm font-medium text-deployguard-300 mb-2">
                Repository URL
              </label>
              <div className="flex items-center gap-2">
                <Code2 className="w-5 h-5 text-deployguard-500 flex-shrink-0" />
                <input
                  type="text"
                  value={formData.repositoryUrl}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, repositoryUrl: e.target.value }))
                  }
                  placeholder="https://github.com/owner/repository"
                  className="w-full bg-deployguard-800 border border-border rounded-lg px-4 py-2.5 text-sm placeholder:text-deployguard-600 focus:outline-none focus:border-accent-cyan/50 transition-colors"
                />
              </div>
            </div>

            {/* Branch */}
            <div>
              <label className="block text-sm font-medium text-deployguard-300 mb-2">
                <GitBranch className="w-4 h-4 inline mr-1" />
                Target Branch
              </label>
              <input
                type="text"
                value={formData.branch}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, branch: e.target.value }))
                }
                placeholder="main"
                className="w-full max-w-xs bg-deployguard-800 border border-border rounded-lg px-4 py-2.5 text-sm placeholder:text-deployguard-600 focus:outline-none focus:border-accent-cyan/50 transition-colors"
              />
            </div>

            {/* Project Name */}
            <div>
              <label className="block text-sm font-medium text-deployguard-300 mb-2">
                Project Name
              </label>
              <input
                type="text"
                value={formData.projectName}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, projectName: e.target.value }))
                }
                placeholder="my-awesome-project"
                className="w-full max-w-md bg-deployguard-800 border border-border rounded-lg px-4 py-2.5 text-sm placeholder:text-deployguard-600 focus:outline-none focus:border-accent-cyan/50 transition-colors"
              />
            </div>
          </div>
        )}

        {/* Step 2: Configuration */}
        {currentStep === 2 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-1">Configure Deployment</h2>
              <p className="text-sm text-deployguard-400">
                Set up AWS region and environment variables
              </p>
            </div>

            {/* AWS Region */}
            <div>
              <label className="block text-sm font-medium text-deployguard-300 mb-2">
                AWS Region
              </label>
              <select
                value={formData.awsRegion}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, awsRegion: e.target.value }))
                }
                className="w-full max-w-xs bg-deployguard-800 border border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-cyan/50 transition-colors"
              >
                <option value="us-east-1">US East (N. Virginia)</option>
                <option value="us-west-2">US West (Oregon)</option>
                <option value="eu-west-1">EU (Ireland)</option>
                <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
              </select>
            </div>

            {/* Environment Variables */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-deployguard-300">
                  Environment Variables
                </label>
                <button
                  onClick={addEnvVar}
                  className="text-xs text-accent-cyan hover:underline"
                >
                  + Add Variable
                </button>
              </div>
              <div className="space-y-2">
                {formData.environmentVars.map((ev, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={ev.key}
                      onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                      placeholder="KEY"
                      className="w-1/3 bg-deployguard-800 border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-deployguard-600 focus:outline-none focus:border-accent-cyan/50 transition-colors"
                    />
                    <input
                      type="text"
                      value={ev.value}
                      onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                      placeholder="value"
                      className="flex-1 bg-deployguard-800 border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-deployguard-600 focus:outline-none focus:border-accent-cyan/50 transition-colors"
                    />
                    {formData.environmentVars.length > 1 && (
                      <button
                        onClick={() => removeEnvVar(i)}
                        className="text-deployguard-500 hover:text-accent-red transition-colors p-1"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-deployguard-500 mt-2">
                Environment variables are encrypted at rest and never exposed in logs
              </p>
            </div>

            {/* Stack Detection */}
            <div>
              <label className="block text-sm font-medium text-deployguard-300 mb-3">
                Stack Detection
              </label>
              {!detected ? (
                <button
                  onClick={handleDetect}
                  disabled={detecting}
                  className="flex items-center gap-2 bg-accent-cyan/10 text-accent-cyan px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-accent-cyan/20 transition-colors disabled:opacity-50"
                >
                  {detecting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Detecting stack...
                    </>
                  ) : (
                    <>
                      <Rocket className="w-4 h-4" />
                      Detect Technology Stack
                    </>
                  )}
                </button>
              ) : (
                <div className="bg-accent-cyan/5 border border-accent-cyan/20 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="w-4 h-4 text-accent-cyan" />
                    <span className="text-sm font-medium text-accent-cyan">Stack Detected</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-deployguard-400">Language:</span>{" "}
                      <span className="text-white">Node.js 20.x</span>
                    </div>
                    <div>
                      <span className="text-deployguard-400">Framework:</span>{" "}
                      <span className="text-white">Next.js 14</span>
                    </div>
                    <div>
                      <span className="text-deployguard-400">Package Manager:</span>{" "}
                      <span className="text-white">npm</span>
                    </div>
                    <div>
                      <span className="text-deployguard-400">Port:</span>{" "}
                      <span className="text-white">3000</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Review & Deploy */}
        {currentStep === 3 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-1">Review & Deploy</h2>
              <p className="text-sm text-deployguard-400">
                Review your configuration before starting the deployment pipeline
              </p>
            </div>

            {/* Review Card */}
            <div className="bg-deployguard-800/50 rounded-lg p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-deployguard-500 block text-xs uppercase tracking-wider">Project Name</span>
                  <p className="mt-1 font-medium">{formData.projectName || "Unnamed Project"}</p>
                </div>
                <div>
                  <span className="text-deployguard-500 block text-xs uppercase tracking-wider">Repository</span>
                  <p className="mt-1 font-medium text-accent-blue">{formData.repositoryUrl || "Not set"}</p>
                </div>
                <div>
                  <span className="text-deployguard-500 block text-xs uppercase tracking-wider">Branch</span>
                  <p className="mt-1 font-medium">{formData.branch}</p>
                </div>
                <div>
                  <span className="text-deployguard-500 block text-xs uppercase tracking-wider">AWS Region</span>
                  <p className="mt-1 font-medium">{formData.awsRegion}</p>
                </div>
                <div>
                  <span className="text-deployguard-500 block text-xs uppercase tracking-wider">Detected Stack</span>
                  <p className="mt-1 font-medium">Next.js 14 (Node.js 20.x)</p>
                </div>
                <div>
                  <span className="text-deployguard-500 block text-xs uppercase tracking-wider">Docker Template</span>
                  <p className="mt-1 font-medium">nextjs-ssr (multi-stage, distroless)</p>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <span className="text-deployguard-500 block text-xs uppercase tracking-wider mb-2">
                  Environment Variables ({formData.environmentVars.length})
                </span>
                {formData.environmentVars.map((ev, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm mb-1">
                    <code className="bg-deployguard-700 px-2 py-0.5 rounded text-accent-cyan">{ev.key}</code>
                    <span className="text-deployguard-500">=</span>
                    <code className="bg-deployguard-700 px-2 py-0.5 rounded">{ev.value}</code>
                  </div>
                ))}
              </div>
            </div>

            {/* Pipeline Steps Preview */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Deployment Pipeline</h3>
              <div className="space-y-2">
                {[
                  { step: "1. Shallow Clone & Stack Detection", time: "~5s" },
                  { step: "2. Docker Build (Multi-stage)", time: "~120s" },
                  { step: "3. Trivy Security Scan", time: "~30s" },
                  { step: "4. Infracost Cost Estimation", time: "~15s" },
                  { step: "5. Terraform Plan & Apply", time: "~180s" },
                  { step: "6. ECS Fargate Deployment", time: "~90s" },
                  { step: "7. ALB Health Check Verification", time: "~60s" },
                ].map((item, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between bg-deployguard-800/50 rounded-lg px-4 py-2.5 text-sm"
                  >
                    <span className="text-deployguard-300">{item.step}</span>
                    <span className="text-deployguard-500 text-xs">{item.time}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Deploy Button */}
            <div className="pt-4 border-t border-border">
              <Link
                href="/projects/proj-001/preflight"
                className="flex items-center justify-center gap-2 w-full sm:w-auto bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 px-8 py-3 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
              >
                <Rocket className="w-4 h-4" />
                Launch Deployment Pipeline
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Buttons */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentStep((prev) => Math.max(1, prev - 1))}
          disabled={currentStep === 1}
          className="flex items-center gap-2 text-sm text-deployguard-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowLeft className="w-4 h-4" />
          Previous
        </button>
        <button
          onClick={() => setCurrentStep((prev) => Math.min(3, prev + 1))}
          disabled={currentStep === 3}
          className="flex items-center gap-2 text-sm text-accent-cyan hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
