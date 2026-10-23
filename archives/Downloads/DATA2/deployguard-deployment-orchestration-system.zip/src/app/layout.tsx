import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import Sidebar from "@/components/sidebar";

export const metadata: Metadata = {
  title: "DeployGuard — DevOps Orchestration Platform",
  description:
    "Enterprise-ready, cloud-native DevOps orchestration platform with zero-configuration pipelines, security scanning, and AI-powered troubleshooting.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-deployguard-950 text-slate-200 antialiased">
        <Sidebar />
        <main className="ml-[250px] min-h-screen">{children}</main>
      </body>
    </html>
  );
}
