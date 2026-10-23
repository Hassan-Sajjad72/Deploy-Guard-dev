import { NextResponse } from "next/server";
import { db } from "@/db";
import { users, projects, deployments, notifications } from "@/db/schema";

export async function GET() {
  try {
    // Seed a demo user
    const [user] = await db.insert(users).values({
      email: "hassan@deployguard.io",
      name: "Hassan Sajjad",
      githubUsername: "hassansajjad",
      role: "admin",
      subscriptionTier: "pro",
    }).returning().onConflictDoNothing();

    // Seed projects
    if (user) {
      await db.insert(projects).values([
        {
          userId: user.id,
          name: "E-Commerce Platform",
          repositoryUrl: "https://github.com/acme/ecommerce-platform",
          branch: "main",
          detectedStack: { language: "Node.js", framework: "Next.js 14", port: 3000 },
          status: "active",
          awsRegion: "us-east-1",
        },
        {
          userId: user.id,
          name: "Analytics Dashboard",
          repositoryUrl: "https://github.com/acme/analytics-dashboard",
          branch: "production",
          detectedStack: { language: "Python", framework: "FastAPI", port: 8000 },
          status: "deploying",
          awsRegion: "us-west-2",
        },
      ]);

      await db.insert(notifications).values([
        {
          userId: user.id,
          type: "deployment",
          title: "Deployment Successful",
          message: "E-Commerce Platform deployed successfully to us-east-1",
          read: false,
        },
      ]);
    }

    return NextResponse.json({ success: true, message: "Seed data inserted" });
  } catch (error) {
    console.error("Seed error:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
