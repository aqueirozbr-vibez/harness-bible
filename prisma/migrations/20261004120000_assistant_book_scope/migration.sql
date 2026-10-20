-- Assistant 2.0, book scope (feature-specs/23 § 7.1, D4): a conversation belongs to a reader and a release and to no
-- chapter. Forward-only, and a relaxation rather than an addition: every row before this stays valid and keeps what
-- Assistant 1 wrote in the three columns; nothing writes or reads them since, and nothing is dropped.
ALTER TABLE "Conversation" ALTER COLUMN "chapter" DROP NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "contextLabel" DROP NOT NULL;
