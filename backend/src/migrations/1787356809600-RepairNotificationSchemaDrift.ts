import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Repairs databases where the historical platform-extension migration was
 * recorded but its notification tables were never materialized.  Every DDL
 * operation is additive/idempotent so existing notification data is retained.
 */
export class RepairNotificationSchemaDrift1787356809600 implements MigrationInterface {
  name = "RepairNotificationSchemaDrift1787356809600";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.notification_preferences (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id integer NOT NULL,
        project_id uuid NOT NULL,
        enabled boolean NOT NULL DEFAULT false,
        critical_enabled boolean NOT NULL DEFAULT true,
        success_enabled boolean NOT NULL DEFAULT true,
        stage_updates_enabled boolean NOT NULL DEFAULT false,
        channel varchar NOT NULL DEFAULT 'email',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(user_id, project_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.notification_subscriptions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id integer NOT NULL,
        project_id uuid NOT NULL,
        destination varchar NOT NULL,
        protocol varchar NOT NULL DEFAULT 'email',
        status varchar NOT NULL DEFAULT 'unconfigured',
        provider_subscription_arn varchar,
        provider_topic_arn varchar,
        confirmed_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(user_id, project_id, destination)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.notification_deliveries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id integer NOT NULL,
        project_id uuid,
        pipeline_run_id uuid,
        event_type varchar NOT NULL,
        deduplication_key varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'pending',
        provider_message_id varchar,
        attempts integer NOT NULL DEFAULT 0,
        last_error varchar,
        subject varchar NOT NULL,
        message text NOT NULL,
        safe_metadata jsonb,
        sent_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS critical_enabled boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS success_enabled boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS stage_updates_enabled boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS channel varchar NOT NULL DEFAULT 'email'`);
    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS protocol varchar NOT NULL DEFAULT 'email'`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'unconfigured'`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_arn varchar`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS provider_topic_arn varchar`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS confirmed_at timestamptz`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS last_error text`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.notification_subscriptions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS provider_message_id varchar`);
    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS last_error varchar`);
    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS safe_metadata jsonb`);
    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS sent_at timestamptz`);
    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.notification_deliveries ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_notification_preferences_user ON public.notification_preferences(user_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_notification_preferences_project ON public.notification_preferences(project_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_user ON public.notification_subscriptions(user_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_project ON public.notification_subscriptions(project_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user ON public.notification_deliveries(user_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_notification_deliveries_project ON public.notification_deliveries(project_id, created_at DESC)`);
  }

  async down(): Promise<void> {
    // Forward repair only: notification history must never be dropped.
  }
}
