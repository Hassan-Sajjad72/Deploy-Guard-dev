import {
  Bell,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  DollarSign,
  Cloud,
  RotateCcw,
  Check,
  Trash2,
  BellOff,
} from "lucide-react";
import { mockNotifications } from "@/lib/mock-data";

function NotificationIcon({ type }: { type: string }) {
  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    deployment: CheckCircle2,
    security: XCircle,
    cost: DollarSign,
    infrastructure: Cloud,
    rollback: RotateCcw,
  };
  const colorMap: Record<string, string> = {
    deployment: "text-accent-cyan bg-accent-cyan/15",
    security: "text-accent-red bg-accent-red/15",
    cost: "text-accent-orange bg-accent-orange/15",
    infrastructure: "text-accent-yellow bg-accent-yellow/15",
    rollback: "text-accent-red bg-accent-red/15",
  };
  const Icon = iconMap[type] || Bell;
  const color = colorMap[type] || "text-deployguard-400 bg-deployguard-700/50";
  return (
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
      <Icon className="w-5 h-5" />
    </div>
  );
}

export default function NotificationsPage() {
  const unread = mockNotifications.filter((n) => !n.read);
  const read = mockNotifications.filter((n) => n.read);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Real-time alerts for deployment events, security findings, and cost thresholds
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-1.5 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <Check className="w-3 h-3" />
            Mark All Read
          </button>
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-1.5 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <BellOff className="w-3 h-3" />
            Preferences
          </button>
        </div>
      </div>

      {/* Unread Count */}
      <div className="bg-accent-cyan/5 border border-accent-cyan/20 rounded-xl p-4 flex items-center gap-3">
        <Bell className="w-5 h-5 text-accent-cyan" />
        <span className="text-sm">
          <span className="font-bold text-accent-cyan">{unread.length}</span> unread notifications
        </span>
      </div>

      {/* Unread Notifications */}
      {unread.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-deployguard-400 uppercase tracking-wider mb-3">New</h2>
          <div className="space-y-2">
            {unread.map((notif) => (
              <div
                key={notif.id}
                className="bg-deployguard-900 border border-border rounded-xl p-4 flex items-start gap-4 hover:border-border-light transition-colors"
              >
                <NotificationIcon type={notif.type} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{notif.title}</h3>
                    <div className="w-2 h-2 rounded-full bg-accent-cyan flex-shrink-0" />
                  </div>
                  <p className="text-xs text-deployguard-400 mt-0.5">{notif.message}</p>
                  <p className="text-[10px] text-deployguard-500 mt-1.5">
                    {new Date(notif.timestamp).toLocaleString()}
                  </p>
                </div>
                <button className="text-deployguard-500 hover:text-accent-red transition-colors p-1">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Read Notifications */}
      <div>
        <h2 className="text-sm font-semibold text-deployguard-400 uppercase tracking-wider mb-3">Earlier</h2>
        <div className="space-y-2">
          {read.map((notif) => (
            <div
              key={notif.id}
              className="bg-deployguard-900/50 border border-border/50 rounded-xl p-4 flex items-start gap-4 opacity-60"
            >
              <NotificationIcon type={notif.type} />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium">{notif.title}</h3>
                <p className="text-xs text-deployguard-400 mt-0.5">{notif.message}</p>
                <p className="text-[10px] text-deployguard-500 mt-1.5">
                  {new Date(notif.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SNS Integration Info */}
      <div className="bg-deployguard-900 border border-border rounded-xl p-5">
        <h2 className="font-semibold mb-3">Notification Channels</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            { channel: "Dashboard", status: "Active", desc: "Real-time in-app notifications" },
            { channel: "Email (SNS)", status: "Active", desc: "Critical events via AWS SNS webhooks" },
            { channel: "Slack", status: "Coming Soon", desc: "Slack webhook integration" },
          ].map((item) => (
            <div key={item.channel} className="bg-deployguard-800/50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">{item.channel}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  item.status === "Active" ? "bg-accent-cyan/15 text-accent-cyan" : "bg-deployguard-700 text-deployguard-400"
                }`}>
                  {item.status}
                </span>
              </div>
              <p className="text-xs text-deployguard-400">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
