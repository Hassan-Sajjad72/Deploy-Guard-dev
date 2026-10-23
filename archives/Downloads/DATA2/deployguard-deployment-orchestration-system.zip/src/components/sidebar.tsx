"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  PlusCircle,
  ShieldCheck,
  DollarSign,
  Activity,
  MessageSquare,
  Cloud,
  FileDown,
  CreditCard,
  ScrollText,
  Bell,
  Hexagon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Projects", href: "/projects", icon: FolderKanban },
  { label: "New Project", href: "/projects/new", icon: PlusCircle },
  { type: "divider" as const, label: "Platform" },
  { label: "Security Scans", href: "/security", icon: ShieldCheck },
  { label: "Cost Analysis", href: "/cost-analysis", icon: DollarSign },
  { label: "Monitoring", href: "/monitoring", icon: Activity },
  { label: "AI Chatbot", href: "/chatbot", icon: MessageSquare },
  { type: "divider" as const, label: "Infrastructure" },
  { label: "Infrastructure", href: "/infrastructure", icon: Cloud },
  { label: "Terraform Export", href: "/terraform-export", icon: FileDown },
  { type: "divider" as const, label: "Account" },
  { label: "Billing", href: "/billing", icon: CreditCard },
  { label: "Audit Log", href: "/audit-log", icon: ScrollText },
  { label: "Notifications", href: "/notifications", icon: Bell },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`fixed left-0 top-0 h-screen bg-deployguard-900 border-r border-border flex flex-col z-50 transition-all duration-300 ${
        collapsed ? "w-[68px]" : "w-[250px]"
      }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-border flex-shrink-0">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent-cyan to-accent-blue flex items-center justify-center flex-shrink-0">
          <Hexagon className="w-5 h-5 text-deployguard-950" />
        </div>
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-accent-cyan to-accent-blue bg-clip-text text-transparent">
            DeployGuard
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {navItems.map((item, i) => {
          if ("type" in item && item.type === "divider") {
            return collapsed ? null : (
              <div
                key={i}
                className="pt-4 pb-2 px-3 text-[10px] uppercase tracking-widest text-deployguard-500 font-semibold"
              >
                {item.label}
              </div>
            );
          }
          const navItem = item as { label: string; href: string; icon: React.ComponentType<{ className?: string }> };
          const Icon = navItem.icon;
          const isActive =
            pathname === navItem.href ||
            (navItem.href !== "/" && pathname.startsWith(navItem.href));

          return (
            <Link
              key={navItem.href}
              href={navItem.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group ${
                isActive
                  ? "bg-accent-cyan/10 text-accent-cyan glow-cyan"
                  : "text-deployguard-300 hover:bg-deployguard-800 hover:text-white"
              }`}
              title={collapsed ? navItem.label : undefined}
            >
              <Icon
                className={`w-5 h-5 flex-shrink-0 ${
                  isActive ? "text-accent-cyan" : "text-deployguard-400 group-hover:text-white"
                }`}
              />
              {!collapsed && <span>{navItem.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse Toggle */}
      <div className="border-t border-border p-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center w-full py-2 rounded-lg text-deployguard-400 hover:bg-deployguard-800 hover:text-white transition-colors"
        >
          {collapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </button>
      </div>
    </aside>
  );
}
