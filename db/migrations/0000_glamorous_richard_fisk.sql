CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`filename` text NOT NULL,
	`role` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`page_count` integer,
	`scanned` integer DEFAULT false NOT NULL,
	`language` text DEFAULT 'unknown' NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`req_id` text NOT NULL,
	`rfq_section_ref` text NOT NULL,
	`description` text NOT NULL,
	`difficulty` text,
	`suggested_compliance` text,
	`suggested_comment` text,
	`rationale` text,
	`evidence` text DEFAULT '[]' NOT NULL,
	`vendor_compliance` text,
	`vendor_comment` text,
	`deviation_ref` text,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`enriched_at` integer,
	`reviewed_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `risk_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`tag_no` text NOT NULL,
	`scope` text NOT NULL,
	`severity` text NOT NULL,
	`reason` text NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tag_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`tag_no` text NOT NULL,
	`helios_service_description` text NOT NULL,
	`ids_service_description` text,
	`ids_sheet_no` integer,
	`technical_envelope` text,
	`vendor_proposed_model` text,
	`catalogue_sheet_ref` text,
	`sil_cert_ref` text,
	`lead_time_weeks` integer,
	`review_status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
