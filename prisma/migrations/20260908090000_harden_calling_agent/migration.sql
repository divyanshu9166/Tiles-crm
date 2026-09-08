-- Persist the actual lifecycle of an AI call instead of treating dispatch as completion.
ALTER TYPE "CallStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "CallStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
ALTER TYPE "CallStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- One LiveKit room represents one call-log record, even when logging retries occur.
CREATE UNIQUE INDEX IF NOT EXISTS "CallLog_livekitRoomId_key"
  ON "CallLog"("livekitRoomId");

-- The fixed showroom slot is the booking resource; this closes the concurrent-booking race.
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_date_time_key"
  ON "Appointment"("date", "time");
