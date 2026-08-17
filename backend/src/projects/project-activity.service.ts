import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectUserActivity } from "./project-user-activity.entity";

type ActivityRoute = { route?: string | null; section?: string | null };

@Injectable()
export class ProjectActivityService {
  constructor(@InjectRepository(ProjectUserActivity) private readonly activities: Repository<ProjectUserActivity>) {}

  async recordView(userId: number, projectId: string, input: ActivityRoute = {}) {
    const now = new Date();
    await this.activities.query(`
      INSERT INTO project_user_activity (user_id, project_id, last_viewed_at, last_route, last_section, updated_at)
      VALUES ($1, $2, $3, $4, $5, $3)
      ON CONFLICT (user_id, project_id) DO UPDATE SET
        last_viewed_at = EXCLUDED.last_viewed_at,
        last_route = COALESCE(project_user_activity.last_route, EXCLUDED.last_route),
        last_section = COALESCE(project_user_activity.last_section, EXCLUDED.last_section),
        updated_at = EXCLUDED.updated_at
    `, [userId, projectId, now, this.safeRoute(input.route), this.safeSection(input.section)]);
  }

  async recordUserAction(userId: number, projectId: string, actionType: string, input: ActivityRoute = {}) {
    const now = new Date();
    await this.activities.query(`
      INSERT INTO project_user_activity (user_id, project_id, last_user_action_at, last_meaningful_activity_at, last_route, last_section, last_action_type, updated_at)
      VALUES ($1, $2, $3, $3, $4, $5, $6, $3)
      ON CONFLICT (user_id, project_id) DO UPDATE SET
        last_user_action_at = EXCLUDED.last_user_action_at,
        last_meaningful_activity_at = EXCLUDED.last_meaningful_activity_at,
        last_route = COALESCE(EXCLUDED.last_route, project_user_activity.last_route),
        last_section = COALESCE(EXCLUDED.last_section, project_user_activity.last_section),
        last_action_type = EXCLUDED.last_action_type,
        updated_at = EXCLUDED.updated_at
    `, [userId, projectId, now, this.safeRoute(input.route), this.safeSection(input.section), this.safeAction(actionType)]);
  }

  async recordPipelineActivity(userId: number, projectId: string, actionType: string, occurredAt = new Date()) {
    await this.activities.query(`
      INSERT INTO project_user_activity (user_id, project_id, last_pipeline_activity_at, last_meaningful_activity_at, last_action_type, updated_at)
      VALUES ($1, $2, $3, $3, $4, $3)
      ON CONFLICT (user_id, project_id) DO UPDATE SET
        last_pipeline_activity_at = GREATEST(project_user_activity.last_pipeline_activity_at, EXCLUDED.last_pipeline_activity_at),
        last_meaningful_activity_at = GREATEST(project_user_activity.last_meaningful_activity_at, EXCLUDED.last_meaningful_activity_at),
        last_action_type = EXCLUDED.last_action_type,
        updated_at = EXCLUDED.updated_at
    `, [userId, projectId, occurredAt, this.safeAction(actionType)]);
  }

  async forUser(userId: number) {
    return this.activities.find({ where: { userId } });
  }

  private safeRoute(value?: string | null) {
    const route = String(value || "").trim();
    return route.startsWith("/projects/") && route.length <= 500 ? route : null;
  }

  private safeSection(value?: string | null) {
    return String(value || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80) || null;
  }

  private safeAction(value: string) {
    return String(value || "project_action").replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 120);
  }
}
