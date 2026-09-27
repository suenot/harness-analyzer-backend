import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PublicSnapshotV1 } from './public-snapshot.js';
import type { AnalyticsDeviceMetadata, PrivateAnalyticsSnapshotV1 } from '@harness-analyzer/core';

export type ShareVisibility = 'private' | 'totals' | 'details';
export type LeaderboardMetric = 'tokens' | 'cost' | 'sessions';
export type PublicAnalyticsPage = 'sessions' | 'projects';

export interface SharingProfile {
  subject: string;
  handle: string;
  display_name: string | null;
  visibility: ShareVisibility;
  leaderboard_opt_in: boolean;
  share_sessions: boolean;
  share_projects: boolean;
  snapshot_generated_at: string | null;
}

export interface SharingUpdate {
  handle?: string;
  display_name?: string | null;
  visibility?: ShareVisibility;
  leaderboard_opt_in?: boolean;
  share_sessions?: boolean;
  share_projects?: boolean;
}

export interface PublicProfile {
  handle: string;
  display_name: string | null;
  visibility: Exclude<ShareVisibility, 'private'>;
  share_sessions: boolean;
  share_projects: boolean;
  snapshot: PublicSnapshotV1;
}

export interface LeaderboardUser {
  handle: string;
  display_name: string | null;
  value: number;
  generated_at: string;
}

export interface PrivateAnalyticsDeviceSnapshot {
  device: AnalyticsDeviceMetadata;
  last_synced_at: string;
  snapshot: PrivateAnalyticsSnapshotV1;
}

export interface ProfileStore {
  init(): Promise<void>;
  getSharing(subject: string): Promise<SharingProfile | null>;
  upsertSharing(subject: string, update: SharingUpdate & { handle: string }): Promise<SharingProfile>;
  saveSnapshot(subject: string, snapshot: PublicSnapshotV1): Promise<void>;
  savePrivateAnalytics(subject: string, snapshot: PrivateAnalyticsSnapshotV1): Promise<void>;
  getPrivateAnalytics(subject: string): Promise<PrivateAnalyticsSnapshotV1 | null>;
  getPrivateAnalyticsDevices(subject: string): Promise<PrivateAnalyticsDeviceSnapshot[]>;
  getPublicAnalytics(handle: string, page: PublicAnalyticsPage): Promise<PrivateAnalyticsSnapshotV1 | null>;
  getPublicProfile(handle: string): Promise<PublicProfile | null>;
  getLeaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardUser[]>;
  getSubjectForSyncTokenHash(tokenHash: string): Promise<string | null>;
  setSyncTokenHash(subject: string, tokenHash: string): Promise<void>;
  revokeSyncToken(subject: string): Promise<void>;
}

export class HandleConflictError extends Error {
  constructor() {
    super('Handle is already taken');
    this.name = 'HandleConflictError';
  }
}

export class InvalidHandleError extends Error {
  constructor(message = 'Handle must be 2-40 lowercase letters, digits or hyphens') {
    super(message);
    this.name = 'InvalidHandleError';
  }
}

export class StaleSnapshotError extends Error {
  constructor() {
    super('Snapshot is older than the stored snapshot');
    this.name = 'StaleSnapshotError';
  }
}

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'dashboard', 'leaderboard', 'login', 'logout', 'me', 'models',
  'profile', 'projects', 'public', 'sessions', 'settings', 'users',
]);

export function normalizeHandle(value: string): string {
  const handle = value.trim().toLowerCase();
  if (handle.length < 2 || handle.length > 40 || !HANDLE_RE.test(handle) || RESERVED_HANDLES.has(handle)) {
    throw new InvalidHandleError();
  }
  return handle;
}

function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface MemoryRecord {
  profile: SharingProfile;
  snapshot: PublicSnapshotV1 | null;
  /** Fallback for records created before per-device storage was introduced. */
  privateAnalytics: PrivateAnalyticsSnapshotV1 | null;
  privateAnalyticsByDevice: Map<string, PrivateAnalyticsDeviceSnapshot>;
}

const LEGACY_DEVICE: AnalyticsDeviceMetadata = {
  id: 'legacy',
  name: 'Legacy device',
  platform: 'unknown',
  architecture: 'unknown',
};

function deviceFor(snapshot: PrivateAnalyticsSnapshotV1): AnalyticsDeviceMetadata {
  return clone(snapshot.device || LEGACY_DEVICE);
}

export function aggregatePrivateAnalytics(
  devices: PrivateAnalyticsDeviceSnapshot[],
): PrivateAnalyticsSnapshotV1 | null {
  if (devices.length === 0) return null;
  const generatedAt = devices.reduce((latest, current) =>
    Date.parse(current.snapshot.generated_at) > Date.parse(latest) ? current.snapshot.generated_at : latest,
  devices[0].snapshot.generated_at);
  return {
    schema_version: devices[0].snapshot.schema_version,
    generated_at: generatedAt,
    history_included: devices.some(device => device.snapshot.history_included),
    sessions: devices.flatMap(device => clone(device.snapshot.sessions)),
  };
}

function sessionFingerprint(session: PrivateAnalyticsSnapshotV1['sessions'][number]): string {
  return JSON.stringify([
    session.date, session.time, session.source, session.cwd,
    session.input_tokens, session.output_tokens, session.cache_read, session.cache_write,
  ]);
}

function deviceSnapshotsFromRows(rows: Record<string, unknown>[]): PrivateAnalyticsDeviceSnapshot[] {
  const groups = new Map<string, PrivateAnalyticsDeviceSnapshot[]>();
  for (const row of rows) {
    const snapshot = deviceSnapshotFromRow(row);
    const canonicalId = String(row.canonical_device_id || snapshot.device.id);
    const group = groups.get(canonicalId) || [];
    group.push(snapshot);
    groups.set(canonicalId, group);
  }
  return [...groups].map(([canonicalId, group]) => {
    if (group.length === 1 && group[0].device.id === canonicalId) return group[0];
    // Prefer the current installation's data when a reinstalled device has the same session.
    group.sort((a, b) => Number(b.device.id === canonicalId) - Number(a.device.id === canonicalId)
      || Date.parse(b.snapshot.generated_at) - Date.parse(a.snapshot.generated_at));
    const preferred = group[0];
    const sessions: PrivateAnalyticsSnapshotV1['sessions'] = [];
    const seen = new Set<string>();
    for (const member of group) {
      const memberKeys: string[] = [];
      for (const session of member.snapshot.sessions) {
        const key = sessionFingerprint(session);
        if (!seen.has(key)) sessions.push(clone(session));
        memberKeys.push(key);
      }
      for (const key of memberKeys) seen.add(key);
    }
    const device = { ...preferred.device, id: canonicalId };
    return {
      device,
      last_synced_at: group.reduce((latest, member) => member.last_synced_at > latest ? member.last_synced_at : latest, preferred.last_synced_at),
      snapshot: {
        ...preferred.snapshot,
        device,
        generated_at: group.reduce((latest, member) => member.snapshot.generated_at > latest ? member.snapshot.generated_at : latest, preferred.snapshot.generated_at),
        history_included: group.some(member => member.snapshot.history_included),
        sessions,
      },
    };
  });
}

export class MemoryProfileStore implements ProfileStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly subjectsByHandle = new Map<string, string>();
  private readonly subjectsBySyncTokenHash = new Map<string, string>();
  private readonly syncTokenHashesBySubject = new Map<string, string>();

  async init(): Promise<void> {}

  async getSharing(subject: string): Promise<SharingProfile | null> {
    const record = this.records.get(subject);
    return record ? clone(record.profile) : null;
  }

  async upsertSharing(subject: string, update: SharingUpdate & { handle: string }): Promise<SharingProfile> {
    const handle = normalizeHandle(update.handle);
    const owner = this.subjectsByHandle.get(handle);
    if (owner && owner !== subject) throw new HandleConflictError();
    const existing = this.records.get(subject);
    if (existing && existing.profile.handle !== handle) this.subjectsByHandle.delete(existing.profile.handle);
    const visibility = update.visibility ?? existing?.profile.visibility ?? 'private';
    const profile: SharingProfile = {
      subject,
      handle,
      display_name: update.display_name !== undefined ? update.display_name : existing?.profile.display_name || null,
      visibility,
      leaderboard_opt_in: update.leaderboard_opt_in ?? existing?.profile.leaderboard_opt_in ?? false,
      share_sessions: visibility === 'details'
        ? update.share_sessions ?? existing?.profile.share_sessions ?? false
        : false,
      share_projects: visibility === 'details'
        ? update.share_projects ?? existing?.profile.share_projects ?? false
        : false,
      snapshot_generated_at: existing?.snapshot?.generated_at || null,
    };
    this.records.set(subject, {
      profile,
      snapshot: existing?.snapshot || null,
      privateAnalytics: existing?.privateAnalytics || null,
      privateAnalyticsByDevice: existing?.privateAnalyticsByDevice || new Map(),
    });
    this.subjectsByHandle.set(handle, subject);
    return clone(profile);
  }

  async saveSnapshot(subject: string, snapshot: PublicSnapshotV1): Promise<void> {
    const record = this.records.get(subject);
    if (!record) throw new Error('Sharing profile does not exist');
    if (record.snapshot && Date.parse(snapshot.generated_at) < Date.parse(record.snapshot.generated_at)) {
      throw new StaleSnapshotError();
    }
    record.snapshot = clone(snapshot);
    record.profile.snapshot_generated_at = snapshot.generated_at;
  }

  async savePrivateAnalytics(subject: string, snapshot: PrivateAnalyticsSnapshotV1): Promise<void> {
    const record = this.records.get(subject);
    if (!record) throw new Error('Sharing profile does not exist');
    const device = deviceFor(snapshot);
    const existing = record.privateAnalyticsByDevice.get(device.id);
    if (existing && Date.parse(snapshot.generated_at) < Date.parse(existing.snapshot.generated_at)) throw new StaleSnapshotError();
    record.privateAnalyticsByDevice.set(device.id, {
      device,
      last_synced_at: new Date().toISOString(),
      snapshot: clone(snapshot),
    });
  }

  async getPrivateAnalytics(subject: string): Promise<PrivateAnalyticsSnapshotV1 | null> {
    const record = this.records.get(subject);
    if (!record) return null;
    if (record.privateAnalyticsByDevice.size > 0) {
      return aggregatePrivateAnalytics([...record.privateAnalyticsByDevice.values()]);
    }
    return record.privateAnalytics ? clone(record.privateAnalytics) : null;
  }

  async getPrivateAnalyticsDevices(subject: string): Promise<PrivateAnalyticsDeviceSnapshot[]> {
    const record = this.records.get(subject);
    if (!record) return [];
    if (record.privateAnalyticsByDevice.size > 0) return [...record.privateAnalyticsByDevice.values()].map(clone);
    return record.privateAnalytics ? [{
      device: clone(LEGACY_DEVICE),
      last_synced_at: record.privateAnalytics.generated_at,
      snapshot: clone(record.privateAnalytics),
    }] : [];
  }

  async getPublicAnalytics(rawHandle: string, page: PublicAnalyticsPage): Promise<PrivateAnalyticsSnapshotV1 | null> {
    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      return null;
    }
    const subject = this.subjectsByHandle.get(handle);
    const record = subject ? this.records.get(subject) : undefined;
    const enabled = page === 'sessions' ? record?.profile.share_sessions : record?.profile.share_projects;
    if (!record?.snapshot || record.profile.visibility !== 'details' || !enabled) return null;
    return this.getPrivateAnalytics(subject!);
  }

  async getPublicProfile(rawHandle: string): Promise<PublicProfile | null> {
    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      return null;
    }
    const subject = this.subjectsByHandle.get(handle);
    const record = subject ? this.records.get(subject) : undefined;
    if (!record?.snapshot || record.profile.visibility === 'private') return null;
    const snapshot = clone(record.snapshot);
    if (record.profile.visibility === 'totals') delete snapshot.details;
    return clone({
      handle: record.profile.handle,
      display_name: record.profile.display_name,
      visibility: record.profile.visibility,
      share_sessions: record.profile.visibility === 'details' && record.profile.share_sessions,
      share_projects: record.profile.visibility === 'details' && record.profile.share_projects,
      snapshot,
    } as PublicProfile);
  }

  async getLeaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardUser[]> {
    const key = metric === 'tokens' ? 'total_tokens' : metric === 'cost' ? 'total_cost' : 'total_sessions';
    return [...this.records.values()]
      .filter(record => record.profile.visibility !== 'private' && record.profile.leaderboard_opt_in && record.snapshot)
      .map(record => ({
        handle: record.profile.handle,
        display_name: record.profile.display_name,
        value: record.snapshot!.totals[key],
        generated_at: record.snapshot!.generated_at,
      }))
      .sort((left, right) => right.value - left.value || left.handle.localeCompare(right.handle))
      .slice(0, limit)
      .map(clone);
  }

  async getSubjectForSyncTokenHash(tokenHash: string): Promise<string | null> {
    return this.subjectsBySyncTokenHash.get(tokenHash) || null;
  }

  async setSyncTokenHash(subject: string, tokenHash: string): Promise<void> {
    if (!this.records.has(subject)) throw new Error('Sharing profile does not exist');
    const previous = this.syncTokenHashesBySubject.get(subject);
    if (previous) this.subjectsBySyncTokenHash.delete(previous);
    this.syncTokenHashesBySubject.set(subject, tokenHash);
    this.subjectsBySyncTokenHash.set(tokenHash, subject);
  }

  async revokeSyncToken(subject: string): Promise<void> {
    const previous = this.syncTokenHashesBySubject.get(subject);
    if (previous) this.subjectsBySyncTokenHash.delete(previous);
    this.syncTokenHashesBySubject.delete(subject);
  }
}

export class PostgresProfileStore implements ProfileStore {
  readonly pool: Pool;

  constructor(connection: string | Pool) {
    this.pool = typeof connection === 'string' ? new Pool({ connectionString: connection }) : connection;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS share_profiles (
        subject TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        display_name TEXT,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'totals', 'details')),
        leaderboard_opt_in BOOLEAN NOT NULL DEFAULT false,
        share_sessions BOOLEAN NOT NULL DEFAULT false,
        share_projects BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS share_sessions BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS share_projects BOOLEAN NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS share_profiles_handle_lower_idx ON share_profiles (LOWER(handle));
      CREATE TABLE IF NOT EXISTS public_snapshots (
        subject TEXT PRIMARY KEY REFERENCES share_profiles(subject) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        snapshot JSONB NOT NULL,
        total_cost NUMERIC(20,6) NOT NULL,
        total_tokens NUMERIC(30,0) NOT NULL,
        total_sessions BIGINT NOT NULL,
        snapshot_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS public_snapshots_cost_idx ON public_snapshots (total_cost DESC);
      CREATE INDEX IF NOT EXISTS public_snapshots_tokens_idx ON public_snapshots (total_tokens DESC);
      CREATE INDEX IF NOT EXISTS public_snapshots_sessions_idx ON public_snapshots (total_sessions DESC);
      CREATE TABLE IF NOT EXISTS sync_tokens (
        subject TEXT PRIMARY KEY REFERENCES share_profiles(subject) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS private_analytics_snapshots (
        subject TEXT PRIMARY KEY REFERENCES share_profiles(subject) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        snapshot JSONB NOT NULL,
        snapshot_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS private_analytics_device_snapshots (
        subject TEXT NOT NULL REFERENCES share_profiles(subject) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        architecture TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        snapshot JSONB NOT NULL,
        snapshot_hash TEXT NOT NULL,
        PRIMARY KEY (subject, device_id)
      );
      CREATE INDEX IF NOT EXISTS private_analytics_device_snapshots_subject_idx
        ON private_analytics_device_snapshots (subject);
      CREATE TABLE IF NOT EXISTS private_analytics_device_aliases (
        subject TEXT NOT NULL,
        alias_device_id TEXT NOT NULL,
        canonical_device_id TEXT NOT NULL,
        PRIMARY KEY (subject, alias_device_id),
        FOREIGN KEY (subject, alias_device_id) REFERENCES private_analytics_device_snapshots (subject, device_id) ON DELETE CASCADE,
        FOREIGN KEY (subject, canonical_device_id) REFERENCES private_analytics_device_snapshots (subject, device_id) ON DELETE CASCADE,
        CHECK (alias_device_id <> canonical_device_id)
      );
    `);
  }

  async getSharing(subject: string): Promise<SharingProfile | null> {
    const result = await this.pool.query(
      `SELECT p.subject, p.handle, p.display_name, p.visibility, p.leaderboard_opt_in,
              p.share_sessions, p.share_projects,
              s.generated_at
         FROM share_profiles p LEFT JOIN public_snapshots s USING (subject)
        WHERE p.subject = $1`,
      [subject],
    );
    return result.rows[0] ? profileFromRow(result.rows[0]) : null;
  }

  async upsertSharing(subject: string, update: SharingUpdate & { handle: string }): Promise<SharingProfile> {
    const handle = normalizeHandle(update.handle);
    try {
      await this.pool.query(
        `INSERT INTO share_profiles
           (subject, handle, display_name, visibility, leaderboard_opt_in, share_sessions, share_projects)
         VALUES (
           $1, $2, $3, COALESCE($4, 'private'), COALESCE($5, false),
           CASE WHEN COALESCE($4, 'private') = 'details' THEN COALESCE($6, false) ELSE false END,
           CASE WHEN COALESCE($4, 'private') = 'details' THEN COALESCE($7, false) ELSE false END
         )
         ON CONFLICT (subject) DO UPDATE SET
           handle = EXCLUDED.handle,
           display_name = CASE WHEN $8 THEN EXCLUDED.display_name ELSE share_profiles.display_name END,
           visibility = COALESCE($4, share_profiles.visibility),
           leaderboard_opt_in = COALESCE($5, share_profiles.leaderboard_opt_in),
           share_sessions = CASE
             WHEN COALESCE($4, share_profiles.visibility) = 'details' THEN COALESCE($6, share_profiles.share_sessions)
             ELSE false
           END,
           share_projects = CASE
             WHEN COALESCE($4, share_profiles.visibility) = 'details' THEN COALESCE($7, share_profiles.share_projects)
             ELSE false
           END,
           updated_at = NOW()`,
        [
          subject, handle, update.display_name ?? null, update.visibility ?? null,
          update.leaderboard_opt_in ?? null, update.share_sessions ?? null, update.share_projects ?? null,
          update.display_name !== undefined,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new HandleConflictError();
      throw error;
    }
    return (await this.getSharing(subject))!;
  }

  async saveSnapshot(subject: string, snapshot: PublicSnapshotV1): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO public_snapshots
         (subject, schema_version, generated_at, snapshot, total_cost, total_tokens, total_sessions, snapshot_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (subject) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         generated_at = EXCLUDED.generated_at,
         uploaded_at = NOW(),
         snapshot = EXCLUDED.snapshot,
         total_cost = EXCLUDED.total_cost,
         total_tokens = EXCLUDED.total_tokens,
         total_sessions = EXCLUDED.total_sessions,
         snapshot_hash = EXCLUDED.snapshot_hash
       WHERE public_snapshots.generated_at <= EXCLUDED.generated_at`,
      [subject, snapshot.schema_version, snapshot.generated_at, JSON.stringify(snapshot), snapshot.totals.total_cost,
        snapshot.totals.total_tokens, snapshot.totals.total_sessions, snapshotHash(snapshot)],
    );
    if (result.rowCount === 0) throw new StaleSnapshotError();
  }

  async savePrivateAnalytics(subject: string, snapshot: PrivateAnalyticsSnapshotV1): Promise<void> {
    const device = deviceFor(snapshot);
    const result = await this.pool.query(
      `INSERT INTO private_analytics_device_snapshots
         (subject, device_id, device_name, platform, architecture, schema_version, generated_at, snapshot, snapshot_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (subject, device_id) DO UPDATE SET
         device_name = EXCLUDED.device_name,
         platform = EXCLUDED.platform,
         architecture = EXCLUDED.architecture,
         schema_version = EXCLUDED.schema_version,
         generated_at = EXCLUDED.generated_at,
         uploaded_at = NOW(),
         snapshot = EXCLUDED.snapshot,
         snapshot_hash = EXCLUDED.snapshot_hash
       WHERE private_analytics_device_snapshots.generated_at <= EXCLUDED.generated_at`,
      [subject, device.id, device.name, device.platform, device.architecture, snapshot.schema_version,
        snapshot.generated_at, JSON.stringify(snapshot), snapshotHash(snapshot)],
    );
    if (result.rowCount === 0) throw new StaleSnapshotError();
  }

  async getPrivateAnalytics(subject: string): Promise<PrivateAnalyticsSnapshotV1 | null> {
    return aggregatePrivateAnalytics(await this.getPrivateAnalyticsDevices(subject));
  }

  async getPrivateAnalyticsDevices(subject: string): Promise<PrivateAnalyticsDeviceSnapshot[]> {
    const result = await this.pool.query(
      `SELECT d.device_id, d.device_name, d.platform, d.architecture, d.generated_at, d.uploaded_at,
              d.snapshot, a.canonical_device_id
         FROM private_analytics_device_snapshots d
         LEFT JOIN private_analytics_device_aliases a
           ON a.subject = d.subject AND a.alias_device_id = d.device_id
        WHERE d.subject = $1
        ORDER BY d.device_id ASC`,
      [subject],
    );
    if (result.rows.length > 0) return deviceSnapshotsFromRows(result.rows);

    const legacy = await this.pool.query(
      `SELECT generated_at, uploaded_at, snapshot FROM private_analytics_snapshots WHERE subject = $1`,
      [subject],
    );
    return legacy.rows[0] ? [{
      device: clone(LEGACY_DEVICE),
      last_synced_at: new Date(legacy.rows[0].uploaded_at || legacy.rows[0].generated_at).toISOString(),
      snapshot: legacy.rows[0].snapshot as PrivateAnalyticsSnapshotV1,
    }] : [];
  }

  async getPublicAnalytics(rawHandle: string, page: PublicAnalyticsPage): Promise<PrivateAnalyticsSnapshotV1 | null> {
    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      return null;
    }
    const flag = page === 'sessions' ? 'share_sessions' : 'share_projects';
    const devices = await this.pool.query(
      `SELECT d.device_id, d.device_name, d.platform, d.architecture,
              d.generated_at, d.uploaded_at, d.snapshot, a.canonical_device_id
         FROM share_profiles p
         JOIN public_snapshots ps USING (subject)
         JOIN private_analytics_device_snapshots d USING (subject)
         LEFT JOIN private_analytics_device_aliases a
           ON a.subject = d.subject AND a.alias_device_id = d.device_id
        WHERE LOWER(p.handle) = $1 AND p.visibility = 'details' AND p.${flag} = true
        ORDER BY d.device_id ASC`,
      [handle],
    );
    if (devices.rows.length > 0) return aggregatePrivateAnalytics(deviceSnapshotsFromRows(devices.rows));

    const legacy = await this.pool.query(
      `SELECT a.snapshot
         FROM share_profiles p
         JOIN public_snapshots ps USING (subject)
         JOIN private_analytics_snapshots a USING (subject)
        WHERE LOWER(p.handle) = $1 AND p.visibility = 'details' AND p.${flag} = true`,
      [handle],
    );
    return legacy.rows[0] ? legacy.rows[0].snapshot as PrivateAnalyticsSnapshotV1 : null;
  }

  async getPublicProfile(rawHandle: string): Promise<PublicProfile | null> {
    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      return null;
    }
    const result = await this.pool.query(
      `SELECT p.handle, p.display_name, p.visibility, p.share_sessions, p.share_projects, s.snapshot
         FROM share_profiles p JOIN public_snapshots s USING (subject)
        WHERE LOWER(p.handle) = $1 AND p.visibility <> 'private'`,
      [handle],
    );
    if (!result.rows[0]) return null;
    const snapshot = result.rows[0].snapshot as PublicSnapshotV1;
    if (result.rows[0].visibility === 'totals') delete snapshot.details;
    return {
      handle: result.rows[0].handle,
      display_name: result.rows[0].display_name,
      visibility: result.rows[0].visibility,
      share_sessions: result.rows[0].visibility === 'details' && Boolean(result.rows[0].share_sessions),
      share_projects: result.rows[0].visibility === 'details' && Boolean(result.rows[0].share_projects),
      snapshot,
    };
  }

  async getLeaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardUser[]> {
    const column = metric === 'tokens' ? 'total_tokens' : metric === 'cost' ? 'total_cost' : 'total_sessions';
    const result = await this.pool.query(
      `SELECT p.handle, p.display_name, s.${column}::double precision AS value, s.generated_at
         FROM share_profiles p JOIN public_snapshots s USING (subject)
        WHERE p.visibility <> 'private' AND p.leaderboard_opt_in = true
        ORDER BY s.${column} DESC, p.handle ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(row => ({
      handle: row.handle,
      display_name: row.display_name,
      value: row.value,
      generated_at: new Date(row.generated_at).toISOString(),
    }));
  }

  async getSubjectForSyncTokenHash(tokenHash: string): Promise<string | null> {
    const result = await this.pool.query(
      `UPDATE sync_tokens SET last_used_at = NOW() WHERE token_hash = $1 RETURNING subject`,
      [tokenHash],
    );
    return result.rows[0] ? String(result.rows[0].subject) : null;
  }

  async setSyncTokenHash(subject: string, tokenHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync_tokens (subject, token_hash) VALUES ($1, $2)
       ON CONFLICT (subject) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = NOW(), last_used_at = NULL`,
      [subject, tokenHash],
    );
  }

  async revokeSyncToken(subject: string): Promise<void> {
    await this.pool.query(`DELETE FROM sync_tokens WHERE subject = $1`, [subject]);
  }
}

function profileFromRow(row: Record<string, unknown>): SharingProfile {
  return {
    subject: String(row.subject),
    handle: String(row.handle),
    display_name: row.display_name === null ? null : String(row.display_name),
    visibility: row.visibility as ShareVisibility,
    leaderboard_opt_in: Boolean(row.leaderboard_opt_in),
    share_sessions: Boolean(row.share_sessions),
    share_projects: Boolean(row.share_projects),
    snapshot_generated_at: row.generated_at ? new Date(row.generated_at as string | Date).toISOString() : null,
  };
}

function deviceSnapshotFromRow(row: Record<string, unknown>): PrivateAnalyticsDeviceSnapshot {
  return {
    device: {
      id: String(row.device_id),
      name: String(row.device_name),
      platform: String(row.platform),
      architecture: String(row.architecture),
    },
    last_synced_at: new Date(row.uploaded_at as string | Date).toISOString(),
    snapshot: row.snapshot as PrivateAnalyticsSnapshotV1,
  };
}

export function createProfileStoreFromEnv(): ProfileStore {
  const connectionString = process.env.PROFILE_DATABASE_URL || process.env.DATABASE_URL;
  return connectionString ? new PostgresProfileStore(connectionString) : new MemoryProfileStore();
}
