CREATE TYPE "public"."competition_kind" AS ENUM('league', 'series', 'tournament');--> statement-breakpoint
CREATE TYPE "public"."competition_status" AS ENUM('upcoming', 'ongoing', 'finished');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('match', 'game', 'round');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('live', 'upcoming', 'recent', 'finished');--> statement-breakpoint
CREATE TYPE "public"."participant_type" AS ENUM('team', 'player');--> statement-breakpoint
CREATE TYPE "public"."sport_key" AS ENUM('cricket', 'chess');--> statement-breakpoint
CREATE TABLE "competition_participants" (
	"competition_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"status" text,
	"final_rank" integer,
	CONSTRAINT "competition_participants_competition_id_participant_id_pk" PRIMARY KEY("competition_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "competition_relevant_countries" (
	"competition_id" uuid NOT NULL,
	"country_id" uuid NOT NULL,
	CONSTRAINT "competition_relevant_countries_competition_id_country_id_pk" PRIMARY KEY("competition_id","country_id")
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport" "sport_key" NOT NULL,
	"name" text NOT NULL,
	"kind" "competition_kind" NOT NULL,
	"status" "competition_status" NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"host_country_id" uuid,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iso2" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "countries_iso2_unique" UNIQUE("iso2")
);
--> statement-breakpoint
CREATE TABLE "event_participants" (
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"role" text,
	"score" text,
	"result" text,
	"position" integer,
	CONSTRAINT "event_participants_event_id_participant_id_pk" PRIMARY KEY("event_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "event_relevant_countries" (
	"event_id" uuid NOT NULL,
	"country_id" uuid NOT NULL,
	CONSTRAINT "event_relevant_countries_event_id_country_id_pk" PRIMARY KEY("event_id","country_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport" "sport_key" NOT NULL,
	"kind" "event_kind" NOT NULL,
	"status" "event_status" NOT NULL,
	"competition_id" uuid,
	"start_time" timestamp with time zone,
	"result" text,
	"venue_country_id" uuid,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport" "sport_key" NOT NULL,
	"type" "participant_type" NOT NULL,
	"name" text NOT NULL,
	"country_id" uuid,
	"title" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" "sport_key" NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "sports_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_relevant_countries" ADD CONSTRAINT "competition_relevant_countries_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_relevant_countries" ADD CONSTRAINT "competition_relevant_countries_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_host_country_id_countries_id_fk" FOREIGN KEY ("host_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_relevant_countries" ADD CONSTRAINT "event_relevant_countries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_relevant_countries" ADD CONSTRAINT "event_relevant_countries_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_country_id_countries_id_fk" FOREIGN KEY ("venue_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_participants_participant_idx" ON "competition_participants" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "competition_relevant_country_idx" ON "competition_relevant_countries" USING btree ("country_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_sport_name_uq" ON "competitions" USING btree ("sport","name");--> statement-breakpoint
CREATE INDEX "competitions_status_idx" ON "competitions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "event_participants_participant_idx" ON "event_participants" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "event_relevant_country_idx" ON "event_relevant_countries" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX "events_sport_status_idx" ON "events" USING btree ("sport","status");--> statement-breakpoint
CREATE INDEX "events_start_time_idx" ON "events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "events_competition_idx" ON "events" USING btree ("competition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_sport_name_uq" ON "participants" USING btree ("sport","name");--> statement-breakpoint
CREATE INDEX "participants_country_idx" ON "participants" USING btree ("country_id");