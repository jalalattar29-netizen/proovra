import * as FileSystem from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { apiFetch } from "./api";
import { captureException } from "./sentry";

type QueueStatus = "PENDING" | "UPLOADING" | "COMPLETING" | "DONE" | "FAILED";

type UploadItem = {
  id: string;
  type: "PHOTO" | "VIDEO" | "DOCUMENT";
  uri: string;
  mimeType: string;
  status: QueueStatus;
  evidenceId?: string | null;
  error?: string | null;
  deviceTimeIso?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  gpsAccuracyMeters?: number | null;
  createdAt: string;
};

const db = SQLite.openDatabaseSync("proovra.db");

function initDb() {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS upload_queue (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      uri TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_id TEXT,
      error TEXT,
      device_time_iso TEXT,
      gps_lat REAL,
      gps_lng REAL,
      gps_accuracy_meters REAL,
      created_at TEXT NOT NULL
    );
  `);
  try {
    db.execSync(`ALTER TABLE upload_queue ADD COLUMN device_time_iso TEXT;`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE upload_queue ADD COLUMN gps_lat REAL;`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE upload_queue ADD COLUMN gps_lng REAL;`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE upload_queue ADD COLUMN gps_accuracy_meters REAL;`);
  } catch {}
}

initDb();

function nowIso() {
  return new Date().toISOString();
}

export function enqueueUpload(item: Omit<UploadItem, "status" | "createdAt">) {
  const id = item.id;
  const stmt = db.prepareSync(
    "INSERT OR REPLACE INTO upload_queue (id, type, uri, mime_type, status, evidence_id, error, device_time_iso, gps_lat, gps_lng, gps_accuracy_meters, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.executeSync(
    id,
    item.type,
    item.uri,
    item.mimeType,
    "PENDING",
    item.evidenceId ?? null,
    item.error ?? null,
    item.deviceTimeIso ?? null,
    item.gpsLat ?? null,
    item.gpsLng ?? null,
    item.gpsAccuracyMeters ?? null,
    nowIso()
  );
  stmt.finalizeSync();
  return id;
}

export function listQueue(): UploadItem[] {
  const rows = db.getAllSync<UploadItem>(
    "SELECT id, type, uri, mime_type as mimeType, status, evidence_id as evidenceId, error, device_time_iso as deviceTimeIso, gps_lat as gpsLat, gps_lng as gpsLng, gps_accuracy_meters as gpsAccuracyMeters, created_at as createdAt FROM upload_queue ORDER BY created_at ASC"
  );
  return rows;
}

function updateStatus(id: string, status: QueueStatus, fields: Partial<UploadItem> = {}) {
  const stmt = db.prepareSync(
    "UPDATE upload_queue SET status = ?, evidence_id = COALESCE(?, evidence_id), error = ?, uri = COALESCE(?, uri), mime_type = COALESCE(?, mime_type), device_time_iso = COALESCE(?, device_time_iso), gps_lat = COALESCE(?, gps_lat), gps_lng = COALESCE(?, gps_lng), gps_accuracy_meters = COALESCE(?, gps_accuracy_meters) WHERE id = ?"
  );
  stmt.executeSync(
    status,
    fields.evidenceId ?? null,
    fields.error ?? null,
    fields.uri ?? null,
    fields.mimeType ?? null,
    fields.deviceTimeIso ?? null,
    fields.gpsLat ?? null,
    fields.gpsLng ?? null,
    fields.gpsAccuracyMeters ?? null,
    id
  );
  stmt.finalizeSync();
}

export async function processQueue() {
  const pending = db.getAllSync<UploadItem>(
    "SELECT id, type, uri, mime_type as mimeType, status, evidence_id as evidenceId, error, device_time_iso as deviceTimeIso, gps_lat as gpsLat, gps_lng as gpsLng, gps_accuracy_meters as gpsAccuracyMeters, created_at as createdAt FROM upload_queue WHERE status IN ('PENDING','FAILED') ORDER BY created_at ASC"
  );
  for (const item of pending) {
    try {
      updateStatus(item.id, "UPLOADING");
      const created = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type: item.type,
          mimeType: item.mimeType,
          deviceTimeIso: item.deviceTimeIso ?? undefined,
          gps:
            item.gpsLat != null && item.gpsLng != null
              ? {
                  lat: item.gpsLat,
                  lng: item.gpsLng,
                  accuracyMeters: item.gpsAccuracyMeters ?? undefined
                }
              : undefined
        })
      });
      updateStatus(item.id, "UPLOADING", { evidenceId: created.id });
      await FileSystem.uploadAsync(created.upload.putUrl, item.uri, {
        httpMethod: "PUT",
        headers: { "content-type": item.mimeType },
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT
      });
      updateStatus(item.id, "COMPLETING");
      await apiFetch(`/v1/evidence/${created.id}/complete`, {
        method: "POST",
        body: "{}"
      });
      updateStatus(item.id, "DONE");
    } catch (err) {
      captureException(err, { feature: "mobile_upload_queue", itemId: item.id });
      updateStatus(item.id, "FAILED", {
        error: err instanceof Error ? err.message : "Upload failed"
      });
    }
  }
}
