CREATE TABLE "schema_certifications" (
	"release" text NOT NULL,
	"fingerprint" text NOT NULL,
	"certified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_certifications_release_fingerprint_pk" PRIMARY KEY("release","fingerprint")
);
