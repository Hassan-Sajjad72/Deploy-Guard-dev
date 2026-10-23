import {
  CreditCard,
  CheckCircle2,
  Zap,
  Crown,
  Download,
  FileText,
  ArrowUpRight,
  TrendingUp,
} from "lucide-react";
import { mockBillingData } from "@/lib/mock-data";

export default function BillingPage() {
  const billing = mockBillingData;
  const usagePercent = (billing.projectsUsed / billing.projectsLimit) * 100;

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Subscription & Billing</h1>
        <p className="text-deployguard-400 text-sm mt-1">
          Manage your plan, view invoices, and track usage
        </p>
      </div>

      {/* Current Plan */}
      <div className="bg-gradient-to-r from-accent-purple/10 to-accent-blue/10 border border-accent-purple/20 rounded-xl p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Crown className="w-5 h-5 text-accent-purple" />
              <span className="text-xs uppercase tracking-widest text-accent-purple font-bold">Current Plan</span>
            </div>
            <h2 className="text-3xl font-bold capitalize">{billing.currentPlan}</h2>
            <p className="text-sm text-deployguard-400 mt-1">
              ${billing.monthlyPrice.toFixed(2)}/month • Next billing: {billing.nextBillingDate}
            </p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold">${billing.monthlyPrice.toFixed(2)}</p>
            <p className="text-xs text-deployguard-400">per month</p>
          </div>
        </div>
      </div>

      {/* Usage Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Projects Used</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-2xl font-bold">{billing.projectsUsed}</span>
            <span className="text-deployguard-400">/ {billing.projectsLimit}</span>
          </div>
          <div className="mt-2 h-1.5 bg-deployguard-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${usagePercent > 80 ? "bg-accent-red" : "bg-accent-cyan"}`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          {usagePercent > 80 && (
            <p className="text-xs text-accent-orange mt-1">Approaching limit</p>
          )}
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Deployments This Month</p>
          <p className="text-2xl font-bold mt-1">{billing.deploymentsThisMonth}</p>
          <p className="text-xs text-deployguard-400 mt-1">Unlimited on Pro plan</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Infrastructure Cost</p>
          <p className="text-2xl font-bold mt-1 text-accent-orange">${billing.costThisMonth.toFixed(2)}</p>
          <p className="text-xs text-deployguard-400 mt-1">AWS resource charges (separate)</p>
        </div>
      </div>

      {/* Plan Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {billing.plans.map((plan) => {
          const isCurrentPlan = plan.name.toLowerCase() === billing.currentPlan;
          return (
            <div
              key={plan.name}
              className={`bg-deployguard-900 border rounded-xl p-6 relative ${
                isCurrentPlan ? "border-accent-cyan/30 glow-cyan" : "border-border"
              }`}
            >
              {isCurrentPlan && (
                <span className="absolute top-4 right-4 px-2 py-0.5 rounded-full text-[10px] font-bold bg-accent-cyan/15 text-accent-cyan uppercase">
                  Current Plan
                </span>
              )}
              <div className="flex items-center gap-3 mb-4">
                {plan.name === "Free" ? (
                  <Zap className="w-6 h-6 text-deployguard-400" />
                ) : (
                  <Crown className="w-6 h-6 text-accent-purple" />
                )}
                <div>
                  <h3 className="text-lg font-bold">{plan.name}</h3>
                  <p className="text-2xl font-bold">
                    ${plan.price}
                    <span className="text-sm text-deployguard-400 font-normal">/month</span>
                  </p>
                </div>
              </div>
              <ul className="space-y-2 mb-6">
                {plan.features.map((feature, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-deployguard-300">
                    <CheckCircle2 className="w-4 h-4 text-accent-cyan flex-shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              {isCurrentPlan ? (
                <button
                  disabled
                  className="w-full py-2.5 rounded-lg text-sm font-medium bg-deployguard-800 text-deployguard-400 cursor-not-allowed"
                >
                  Current Plan
                </button>
              ) : (
                <button className="w-full py-2.5 rounded-lg text-sm font-bold bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 hover:opacity-90 transition-opacity">
                  Upgrade to {plan.name}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Payment Method */}
      <div className="bg-deployguard-900 border border-border rounded-xl p-5">
        <h2 className="font-semibold mb-4">Payment Method</h2>
        <div className="flex items-center gap-4 bg-deployguard-800/50 rounded-lg p-4">
          <CreditCard className="w-8 h-8 text-deployguard-400" />
          <div className="flex-1">
            <p className="text-sm font-medium">•••• •••• •••• 4242</p>
            <p className="text-xs text-deployguard-400">Expires 12/2027</p>
          </div>
          <button className="text-xs text-accent-cyan hover:underline">Update</button>
        </div>
      </div>

      {/* Invoices */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="p-5 border-b border-border">
          <h2 className="font-semibold">Invoices</h2>
        </div>
        <div className="divide-y divide-border">
          {billing.invoices.map((invoice) => (
            <div key={invoice.id} className="p-4 flex items-center justify-between hover:bg-deployguard-800/30 transition-colors">
              <div className="flex items-center gap-3">
                <FileText className="w-4 h-4 text-deployguard-400" />
                <div>
                  <p className="text-sm font-medium">{invoice.id}</p>
                  <p className="text-xs text-deployguard-400">{new Date(invoice.date).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium">
                  {invoice.amount === 0 ? "Free" : `$${invoice.amount.toFixed(2)}`}
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-accent-cyan/15 text-accent-cyan uppercase">
                  {invoice.status}
                </span>
                <button className="text-deployguard-400 hover:text-white transition-colors">
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
