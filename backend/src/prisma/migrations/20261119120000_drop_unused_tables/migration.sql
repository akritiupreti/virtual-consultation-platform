-- DropTable (also drops their indexes and foreign keys)
DROP TABLE "attachments";

-- DropTable
DROP TABLE "addenda";

-- AlterTable
ALTER TABLE "summaries" DROP COLUMN "changes_requested_at",
DROP COLUMN "changes_requested_note";
