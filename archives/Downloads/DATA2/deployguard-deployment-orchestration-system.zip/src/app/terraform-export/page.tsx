import {
  FileDown,
  FileArchive,
  CheckCircle2,
  Shield,
  Code2,
  Lock,
  Download,
  ExternalLink,
  FolderOpen,
} from "lucide-react";
import Link from "next/link";

export default function TerraformExportPage() {
  const exportFiles = [
    { name: "main.tf", description: "Primary Terraform configuration — VPC, ECS, ALB resources", size: "4.2 KB" },
    { name: "variables.tf", description: "Input variable definitions — region, instance count, ports", size: "1.1 KB" },
    { name: "outputs.tf", description: "Output values — ALB DNS, ECS cluster name, VPC ID", size: "0.8 KB" },
    { name: "terraform.tfvars", description: "Variable assignments — your project-specific values", size: "0.5 KB" },
    { name: "backend.tf", description: "S3 + DynamoDB remote state configuration", size: "0.6 KB" },
    { name: "providers.tf", description: "AWS provider configuration with region", size: "0.3 KB" },
    { name: "ecs.tf", description: "ECS Fargate service, task definition, auto-scaling", size: "3.8 KB" },
    { name: "networking.tf", description: "VPC, subnets, NAT gateway, security groups", size: "2.9 KB" },
    { name: "storage.tf", description: "EFS file system, mount targets, access points", size: "1.5 KB" },
    { name: "monitoring.tf", description: "CloudWatch log groups, alarms, dashboards", size: "1.2 KB" },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Terraform Export</h1>
        <p className="text-deployguard-400 text-sm mt-1">
          No Lock-in — Download your infrastructure as code with one click
        </p>
      </div>

      {/* No Lock-in Banner */}
      <div className="bg-accent-cyan/5 border border-accent-cyan/20 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-accent-cyan/15 flex items-center justify-center flex-shrink-0">
            <Shield className="w-6 h-6 text-accent-cyan" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-accent-cyan">100% Vendor Independence</h2>
            <p className="text-sm text-deployguard-300 mt-1">
              DeployGuard never locks you in. Every piece of your infrastructure is defined as HashiCorp Terraform
              code that you can download and run independently. You own your infrastructure — always.
            </p>
          </div>
        </div>
      </div>

      {/* What You Get */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          {
            icon: Code2,
            title: "Standard Terraform HCL",
            description: "Pure HashiCorp Configuration Language — no proprietary extensions or custom syntax.",
          },
          {
            icon: Lock,
            title: "Portable State Config",
            description: "Remote state configuration included. Re-point to your own S3 bucket and DynamoDB table.",
          },
          {
            icon: FileArchive,
            title: "Complete .zip Archive",
            description: "All Terraform files packaged together with proper module structure and documentation.",
          },
        ].map((item, i) => {
          const ItemIcon = item.icon;
          return (
            <div key={i} className="bg-deployguard-900 border border-border rounded-xl p-5">
              <ItemIcon className="w-6 h-6 text-accent-cyan mb-3" />
              <h3 className="text-sm font-semibold mb-1">{item.title}</h3>
              <p className="text-xs text-deployguard-400">{item.description}</p>
            </div>
          );
        })}
      </div>

      {/* Export Files */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="font-semibold">Export Contents</h2>
            <p className="text-xs text-deployguard-400 mt-0.5">
              Files included in your .zip archive
            </p>
          </div>
          <span className="text-xs text-deployguard-400">
            {exportFiles.length} files • ~17 KB total
          </span>
        </div>
        <div className="divide-y divide-border">
          {exportFiles.map((file, i) => (
            <div key={i} className="p-4 flex items-center gap-3 hover:bg-deployguard-800/30 transition-colors">
              <FileDown className="w-4 h-4 text-accent-blue flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono font-medium">{file.name}</p>
                <p className="text-xs text-deployguard-400 truncate">{file.description}</p>
              </div>
              <span className="text-xs text-deployguard-500 flex-shrink-0">{file.size}</span>
            </div>
          ))}
        </div>
      </div>

      {/* How to Use Export */}
      <div className="bg-deployguard-900 border border-border rounded-xl p-5">
        <h2 className="font-semibold mb-4">Using Your Export</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { step: "1", title: "Download .zip", desc: "Click export to download your Terraform archive" },
            { step: "2", title: "Extract Files", desc: "Unzip to any directory on your local machine" },
            { step: "3", title: "Configure Backend", desc: "Update backend.tf with your S3/DynamoDB details" },
            { step: "4", title: "Terraform Apply", desc: "Run terraform init && terraform apply independently" },
          ].map((item) => (
            <div key={item.step} className="bg-deployguard-800/50 rounded-lg p-4">
              <div className="w-8 h-8 rounded-full bg-accent-cyan/15 text-accent-cyan flex items-center justify-center text-sm font-bold mb-3">
                {item.step}
              </div>
              <h3 className="text-sm font-semibold mb-1">{item.title}</h3>
              <p className="text-xs text-deployguard-400">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Export Button */}
      <div className="flex items-center gap-4">
        <button className="flex items-center gap-2 bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 px-6 py-3 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
          <Download className="w-4 h-4" />
          Export Terraform Scripts (.zip)
        </button>
        <Link
          href="/infrastructure"
          className="flex items-center gap-2 bg-deployguard-800 border border-border px-5 py-3 rounded-lg text-sm text-deployguard-300 hover:text-white hover:border-border-light transition-colors"
        >
          <FolderOpen className="w-4 h-4" />
          View Infrastructure
        </Link>
      </div>
    </div>
  );
}
