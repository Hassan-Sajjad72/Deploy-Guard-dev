import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  ArrowUpRight,
  Download,
} from "lucide-react";
import Link from "next/link";
import { mockCostBreakdown, mockProjects } from "@/lib/mock-data";

export default function CostAnalysisPage() {
  const project = mockProjects[0];
  const totalCost = mockCostBreakdown.reduce((sum, item) => sum + item.monthlyCost, 0);
  const spotSavings = totalCost * 0.38; // 38% savings with Spot
  const onDemandCost = totalCost + spotSavings;

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cost Analysis (FinOps)</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Infracost pre-deployment cost transparency & approval workflow
          </p>
        </div>
        <button className="flex items-center gap-2 bg-deployguard-800 border border-border px-4 py-2 rounded-lg text-sm text-deployguard-300 hover:text-white hover:border-border-light transition-colors">
          <Download className="w-4 h-4" />
          Export Cost Report
        </button>
      </div>

      {/* Cost Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs text-deployguard-400 mb-2">
            <DollarSign className="w-3.5 h-3.5" />
            Estimated Monthly Cost (Spot)
          </div>
          <p className="text-3xl font-bold text-accent-cyan">${totalCost.toFixed(2)}</p>
          <p className="text-xs text-deployguard-400 mt-1">Based on current Terraform plan</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs text-deployguard-400 mb-2">
            <TrendingDown className="w-3.5 h-3.5 text-accent-cyan" />
            Savings with Fargate Spot
          </div>
          <p className="text-3xl font-bold text-accent-cyan">${spotSavings.toFixed(2)}</p>
          <p className="text-xs text-deployguard-400 mt-1">
            vs ${onDemandCost.toFixed(2)} on-demand (38% savings)
          </p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs text-deployguard-400 mb-2">
            <TrendingUp className="w-3.5 h-3.5 text-accent-orange" />
            Warning Threshold
          </div>
          <p className="text-3xl font-bold text-accent-orange">$50.00</p>
          <p className="text-xs text-deployguard-400 mt-1">
            Costs above this require explicit approval
          </p>
        </div>
      </div>

      {/* Approval Status */}
      <div className={`rounded-xl border p-5 flex items-center gap-4 ${
        totalCost > 50
          ? "bg-accent-orange/5 border-accent-orange/20"
          : "bg-accent-cyan/5 border-accent-cyan/20"
      }`}>
        {totalCost > 50 ? (
          <AlertTriangle className="w-8 h-8 text-accent-orange flex-shrink-0" />
        ) : (
          <CheckCircle2 className="w-8 h-8 text-accent-cyan flex-shrink-0" />
        )}
        <div className="flex-1">
          <h2 className={`text-lg font-bold ${totalCost > 50 ? "text-accent-orange" : "text-accent-cyan"}`}>
            {totalCost > 50 ? "Cost Approval Required" : "Within Budget Threshold"}
          </h2>
          <p className="text-sm text-deployguard-300 mt-0.5">
            {totalCost > 50
              ? `Estimated cost ($${totalCost.toFixed(2)}/mo) exceeds your warning threshold of $50.00/mo. Explicit approval required before infrastructure provisioning begins.`
              : `Estimated cost ($${totalCost.toFixed(2)}/mo) is within your configured warning threshold of $50.00/mo.`}
          </p>
        </div>
        {totalCost > 50 && (
          <button className="flex items-center gap-2 bg-accent-orange text-deployguard-950 px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity">
            Approve Cost
            <ArrowUpRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Cost Breakdown */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="p-5 border-b border-border">
          <h2 className="font-semibold">Resource Cost Breakdown</h2>
          <p className="text-xs text-deployguard-400 mt-1">
            Infracost real-time AWS pricing data per Terraform resource
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Resource</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Monthly Cost</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">% of Total</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Visual</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {mockCostBreakdown.map((item, i) => (
                <tr key={i} className="hover:bg-deployguard-800/30 transition-colors">
                  <td className="px-5 py-3 font-medium">{item.resource}</td>
                  <td className="px-5 py-3 text-accent-cyan font-mono">${item.monthlyCost.toFixed(2)}</td>
                  <td className="px-5 py-3 text-deployguard-400">
                    {((item.monthlyCost / totalCost) * 100).toFixed(1)}%
                  </td>
                  <td className="px-5 py-3">
                    <div className="w-32 h-2 bg-deployguard-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-accent-cyan to-accent-blue rounded-full"
                        style={{ width: `${(item.monthlyCost / totalCost) * 100}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="bg-deployguard-800/30 font-bold">
                <td className="px-5 py-3">Total</td>
                <td className="px-5 py-3 text-accent-cyan">${totalCost.toFixed(2)}</td>
                <td className="px-5 py-3">100%</td>
                <td className="px-5 py-3">
                  <div className="w-32 h-2 bg-accent-cyan/30 rounded-full overflow-hidden">
                    <div className="h-full bg-accent-cyan rounded-full w-full" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Infracost Integration Info */}
      <div className="bg-deployguard-900 border border-border rounded-xl p-5">
        <h2 className="font-semibold mb-4">How Cost Estimation Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              step: "1",
              title: "Terraform Plan",
              description: "System generates a Terraform execution plan describing all resources to be created or modified.",
            },
            {
              step: "2",
              title: "Infracost Analysis",
              description: "Plan is parsed and submitted to Infracost API, which returns real-time AWS pricing for each resource.",
            },
            {
              step: "3",
              title: "Governed Approval",
              description: "Cost estimates are evaluated against tier limits and warning thresholds. Exceeding costs require explicit user approval.",
            },
          ].map((item) => (
            <div key={item.step} className="bg-deployguard-800/50 rounded-lg p-4">
              <div className="w-8 h-8 rounded-full bg-accent-cyan/15 text-accent-cyan flex items-center justify-center text-sm font-bold mb-3">
                {item.step}
              </div>
              <h3 className="text-sm font-semibold mb-1">{item.title}</h3>
              <p className="text-xs text-deployguard-400">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
