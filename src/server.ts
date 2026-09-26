import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenError, hasHarnessRole, verifyHarnessAccess, type AuthIdentity, type AuthVerifier } from './auth.js';
import {
  getData, refreshData, filterSessions, getSessionById,
  getProjectStats, getDailyChart, getDailyModelChart, getHistoryChart, getHeatmapData, getModelStats, getModelUsage, getSourceStats, getSourceUsage,
  getHourlyStats, getCacheStats, getCacheExpiryStats,
  isReady, startBackgroundCollect,
} from './services/data-service.js';
import { modelPricingService } from './services/model-pricing-service.js';
import {
  createProfileStoreFromEnv,
  HandleConflictError,
  InvalidHandleError,
  normalizeHandle,
  StaleSnapshotError,
  type LeaderboardMetric,
  type ProfileStore,
  type ShareVisibility,
} from './profile-store.js';
import { buildPublicSnapshot, InvalidSnapshotError, validatePublicSnapshot } from './public-snapshot.js';
import {
  buildSummary,
  getProjectStats as getPrivateProjectStats,
  InvalidPrivateSnapshotError,
  validatePrivateAnalyticsSnapshot,
  type Session,
} from '@harness-analyzer/core';

type PricingService = Pick<typeof modelPricingService, 'getModelPricing'>;
const MAX_PUBLIC_PROJECTS = 2_000;

interface PublicSession {
  date: string;
  time: string;
  source: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  model: string;
}

function publicDimension(value: string | undefined, fallback: string, maxLength = 200): string {
  const label = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
  return !label || Object.prototype.hasOwnProperty.call(Object.prototype, label) ? fallback : label;
}

function publicProjectLabel(value: string | undefined): string {
  if (!value) return '(no project)';
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const label = normalized.split('/').pop()?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!label || label === '.' || label === '..') return '(no project)';
  return publicDimension(label, '(no project)');
}

function publicSession(session: Session): PublicSession {
  return {
    date: session.date,
    time: session.time,
    source: publicDimension(session.source, 'Unknown'),
    cost: session.cost,
    input_tokens: session.input_tokens,
    output_tokens: session.output_tokens,
    cache_read: session.cache_read,
    cache_write: session.cache_write,
    model: publicDimension(session.model, 'unknown'),
  };
}

function publicProjects(sessions: Session[]) {
  interface BreakdownValue { usd: number; tokens: number; sessions: number }
  interface ProjectValue extends BreakdownValue {
    byModel: Map<string, BreakdownValue>;
    byHarness: Map<string, BreakdownValue>;
  }
  const projects = new Map<string, ProjectValue>();
  const add = (breakdown: Map<string, BreakdownValue>, key: string, usd: number, tokens: number) => {
    const value = breakdown.get(key) || { usd: 0, tokens: 0, sessions: 0 };
    value.usd += usd;
    value.tokens += tokens;
    value.sessions++;
    breakdown.set(key, value);
  };
  const allocate = (breakdown: Map<string, BreakdownValue>, totalCents: number) => {
    const entries = [...breakdown.entries()].map(([key, value]) => {
      const rawCents = value.usd * 100;
      const cents = Math.floor(rawCents);
      return { key, value, cents, remainder: rawCents - cents };
    });
    const remaining = totalCents - entries.reduce((sum, entry) => sum + entry.cents, 0);
    const allocationOrder = [...entries].sort((left, right) =>
      right.remainder - left.remainder || left.key.localeCompare(right.key));
    for (let index = 0; index < remaining; index++) allocationOrder[index].cents++;
    return Object.fromEntries(entries.sort((left, right) => left.key.localeCompare(right.key)).map(entry => [
      entry.key,
      { usd: entry.cents / 100, tokens: entry.value.tokens, sessions: entry.value.sessions },
    ]));
  };

  for (const session of sessions) {
    const label = publicProjectLabel(session.cwd);
    const model = publicDimension(session.model, 'unknown');
    const harness = publicDimension(session.source, 'Unknown');
    const tokens = session.input_tokens + session.output_tokens + session.cache_read + session.cache_write;
    const project = projects.get(label) || {
      usd: 0, tokens: 0, sessions: 0, byModel: new Map(), byHarness: new Map(),
    };
    project.usd += session.cost;
    project.tokens += tokens;
    project.sessions++;
    add(project.byModel, model, session.cost, tokens);
    add(project.byHarness, harness, session.cost, tokens);
    projects.set(label, project);
  }

  return [...projects.entries()].map(([label, project]) => {
    const totalCents = Math.round(project.usd * 100 + Number.EPSILON * Math.max(1, Math.abs(project.usd * 100)));
    return {
      label,
      cost: totalCents / 100,
      tokens: project.tokens,
      sessions: project.sessions,
      sources: [...project.byHarness.keys()].sort((left, right) => left.localeCompare(right)),
      models: [...project.byModel.keys()].sort((left, right) => left.localeCompare(right)),
      byModel: allocate(project.byModel, totalCents),
      byHarness: allocate(project.byHarness, totalCents),
    };
  }).sort((left, right) => right.cost - left.cost || left.label.localeCompare(right.label))
    .slice(0, MAX_PUBLIC_PROJECTS);
}

const DEFAULT_ALLOWED_ORIGINS = [
  'https://harness-analyzer.marketmaker.cc',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];

function configuredOrigins(): string[] {
  return (process.env.CORS_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export function createApp(options: {
  isReady?: typeof isReady;
  modelPricingService?: PricingService;
  dataProvider?: typeof getData;
  authVerifier?: AuthVerifier;
  allowedOrigins?: string[];
  profileStore?: ProfileStore;
  snapshotExportEnabled?: boolean;
  snapshotExportOwnerSubject?: string;
} = {}) {
  const ready = options.isReady ?? isReady;
  const pricing = options.modelPricingService ?? modelPricingService;
  const dataProvider = options.dataProvider ?? getData;
  const authVerifier = options.authVerifier ?? verifyHarnessAccess;
  const profileStore = options.profileStore ?? createProfileStoreFromEnv();
  const profileStoreReady = profileStore.init().then(() => true, () => false);
  const snapshotExportEnabled = options.snapshotExportEnabled ?? (
    process.env.SNAPSHOT_EXPORT_ENABLED !== undefined
      ? process.env.SNAPSHOT_EXPORT_ENABLED === 'true'
      : process.env.NODE_ENV !== 'production'
  );
  const snapshotExportOwnerSubject = options.snapshotExportOwnerSubject ?? process.env.SNAPSHOT_EXPORT_OWNER_SUBJECT;
  const allowedOrigins = new Set(options.allowedOrigins ?? configuredOrigins());
  const app = new Hono<{ Variables: { identity: AuthIdentity } }>();

  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.header('Access-Control-Request-Private-Network') === 'true') {
      c.header('Access-Control-Allow-Private-Network', 'true');
    }
  });

  app.use('/api/*', cors({
    origin: origin => allowedOrigins.has(origin) ? origin : '',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }));

  app.use('/api/me/public-snapshot', bodyLimit({
    maxSize: 1_000_000,
    onError: c => c.json({ error: 'Snapshot is too large' }, 413),
  }));
  app.use('/api/me/analytics', bodyLimit({
    maxSize: 50 * 1024 * 1024,
    onError: c => c.json({ error: 'Analytics upload is too large' }, 413),
  }));

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/status' || c.req.path.startsWith('/api/public/')) return next();
    const authorization = c.req.header('Authorization') || '';
    if (authorization.startsWith('Sync ')) {
      const syncAllowed = (c.req.path === '/api/me/sharing' && c.req.method === 'GET') ||
        (c.req.path === '/api/me/public-snapshot' && c.req.method === 'PUT') ||
        (c.req.path === '/api/me/analytics' && c.req.method === 'PUT');
      if (!syncAllowed) return c.json({ error: 'Forbidden' }, 403);
      if (!await profileStoreReady) return c.json({ error: 'Profile storage unavailable' }, 503);
      const token = authorization.slice('Sync '.length).trim();
      if (!/^ha_sync_[A-Za-z0-9_-]{40,}$/.test(token)) return c.json({ error: 'Invalid sync token' }, 401);
      const subject = await profileStore.getSubjectForSyncTokenHash(createHash('sha256').update(token).digest('hex'));
      if (!subject) return c.json({ error: 'Invalid sync token' }, 401);
      c.set('identity', { subject, services: { 'harness-analyzer': 'user' } });
      return next();
    }
    if (!authorization.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    try {
      const identity = await authVerifier(authorization.slice('Bearer '.length).trim());
      c.set('identity', identity);
      const allowed = c.req.path.startsWith('/api/me/')
        ? hasHarnessRole(identity, ['user', 'superuser', 'admin'])
        : hasHarnessRole(identity, ['admin']);
      if (!allowed) return c.json({ error: 'Forbidden' }, 403);
    } catch (error) {
      if (error instanceof ForbiddenError) return c.json({ error: 'Forbidden' }, 403);
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    return next();
  });

  // Return 503 while data is loading
  app.use('/api/*', async (c, next) => {
    const independent = c.req.path === '/api/status' || c.req.path.startsWith('/api/public/') ||
      c.req.path === '/api/models/pricing' || c.req.path === '/api/me/sharing' ||
      c.req.path === '/api/me/public-snapshot' || c.req.path.startsWith('/api/me/analytics');
    if (!ready() && !independent) {
      return c.json({ loading: true, message: 'Collecting data, please wait...' }, 503);
    }
    return next();
  });

  app.get('/api/status', async (c) => {
    const profileStorageReady = await profileStoreReady;
    const collectorReady = ready();
    return c.json({
      ready: collectorReady && profileStorageReady,
      collector_ready: collectorReady,
      profile_storage_ready: profileStorageReady,
    });
  });

  const waitForProfileStore = async () => {
    return profileStoreReady;
  };

  const ensureSharing = async (identity: AuthIdentity) => {
    const existing = await profileStore.getSharing(identity.subject);
    if (existing) return existing;
    let preferred: string;
    try {
      preferred = normalizeHandle(identity.username || 'user');
    } catch {
      preferred = 'user';
    }
    try {
      return await profileStore.upsertSharing(identity.subject, {
        handle: preferred,
        display_name: identity.username || null,
        visibility: 'private',
        leaderboard_opt_in: false,
        share_sessions: false,
        share_projects: false,
      });
    } catch (error) {
      if (!(error instanceof HandleConflictError)) throw error;
      const suffix = createHash('sha256').update(identity.subject).digest('hex').slice(0, 6);
      const base = preferred.slice(0, 40 - suffix.length - 1).replace(/-+$/, '') || 'user';
      return profileStore.upsertSharing(identity.subject, {
        handle: `${base}-${suffix}`,
        display_name: identity.username || null,
        visibility: 'private',
        leaderboard_opt_in: false,
        share_sessions: false,
        share_projects: false,
      });
    }
  };

  const sharingResponse = ({ subject: _subject, ...profile }: Awaited<ReturnType<typeof ensureSharing>>) => profile;

  app.get('/api/public/users/:handle', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const profile = await profileStore.getPublicProfile(c.req.param('handle'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(profile);
  });

  app.get('/api/public/users/:handle/sessions', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const snapshot = await profileStore.getPublicAnalytics(c.req.param('handle'), 'sessions');
    if (!snapshot) return c.json({ error: 'Not found' }, 404);
    const filtered = filterSessions(snapshot.sessions, {
      source: c.req.query('source'), model: c.req.query('model'), from: c.req.query('from'), to: c.req.query('to'),
      minCost: c.req.query('minCost') ? parseFloat(c.req.query('minCost')!) : undefined,
    });
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
    const sorted = filtered.sort((left, right) =>
      right.date.localeCompare(left.date) || right.time.localeCompare(left.time));
    return c.json({ total: sorted.length, sessions: sorted.slice(offset, offset + limit).map(publicSession) });
  });

  app.get('/api/public/users/:handle/projects', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const snapshot = await profileStore.getPublicAnalytics(c.req.param('handle'), 'projects');
    if (!snapshot) return c.json({ error: 'Not found' }, 404);
    return c.json(publicProjects(snapshot.sessions));
  });

  app.get('/api/public/leaderboard', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const metric = c.req.query('metric') || 'tokens';
    if (!['tokens', 'cost', 'sessions'].includes(metric)) return c.json({ error: 'Invalid metric' }, 400);
    const rawLimit = Number(c.req.query('limit') || '50');
    if (!Number.isInteger(rawLimit) || rawLimit < 1) return c.json({ error: 'Invalid limit' }, 400);
    const limit = Math.min(rawLimit, 100);
    const users = await profileStore.getLeaderboard(metric as LeaderboardMetric, limit);
    return c.json({
      metric,
      self_reported: true,
      users: users.map((user, index) => ({ rank: index + 1, ...user })),
    });
  });

  app.get('/api/me/sharing', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    return c.json(sharingResponse(await ensureSharing(c.get('identity'))));
  });

  app.post('/api/me/sync-token', async (c) => {
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const identity = c.get('identity');
    await ensureSharing(identity);
    const token = `ha_sync_${randomBytes(32).toString('base64url')}`;
    await profileStore.setSyncTokenHash(identity.subject, createHash('sha256').update(token).digest('hex'));
    return c.json({ token });
  });

  app.delete('/api/me/sync-token', async (c) => {
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    await profileStore.revokeSyncToken(c.get('identity').subject);
    return c.json({ ok: true });
  });

  app.put('/api/me/sharing', async (c) => {
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid body' }, 400);
    }
    const allowedKeys = new Set([
      'handle', 'display_name', 'visibility', 'leaderboard_opt_in', 'share_sessions', 'share_projects',
    ]);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowedKeys.has(key))) {
      return c.json({ error: 'Invalid body' }, 400);
    }
    const current = await ensureSharing(c.get('identity'));
    if (body.handle !== undefined && typeof body.handle !== 'string') return c.json({ error: 'Invalid handle' }, 400);
    if (body.display_name !== undefined && body.display_name !== null &&
        (typeof body.display_name !== 'string' || body.display_name.length > 80 || /[\u0000-\u001f\u007f]/.test(body.display_name))) {
      return c.json({ error: 'Invalid display name' }, 400);
    }
    if (body.visibility !== undefined && !['private', 'totals', 'details'].includes(String(body.visibility))) {
      return c.json({ error: 'Invalid visibility' }, 400);
    }
    if (body.leaderboard_opt_in !== undefined && typeof body.leaderboard_opt_in !== 'boolean') {
      return c.json({ error: 'Invalid leaderboard preference' }, 400);
    }
    if (body.share_sessions !== undefined && typeof body.share_sessions !== 'boolean') {
      return c.json({ error: 'Invalid sessions sharing preference' }, 400);
    }
    if (body.share_projects !== undefined && typeof body.share_projects !== 'boolean') {
      return c.json({ error: 'Invalid projects sharing preference' }, 400);
    }
    const visibility = (body.visibility as ShareVisibility | undefined) ?? current.visibility;
    try {
      const profile = await profileStore.upsertSharing(c.get('identity').subject, {
        handle: body.handle === undefined ? current.handle : body.handle as string,
        display_name: body.display_name as string | null | undefined,
        visibility,
        leaderboard_opt_in: body.leaderboard_opt_in as boolean | undefined,
        share_sessions: visibility === 'details' ? body.share_sessions as boolean | undefined : false,
        share_projects: visibility === 'details' ? body.share_projects as boolean | undefined : false,
      });
      return c.json(sharingResponse(profile));
    } catch (error) {
      if (error instanceof HandleConflictError) return c.json({ error: error.message }, 409);
      if (error instanceof InvalidHandleError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.put('/api/me/public-snapshot', async (c) => {
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const identity = c.get('identity');
    if (!await profileStore.getSharing(identity.subject)) return c.json({ error: 'Create sharing profile first' }, 409);
    try {
      const snapshot = validatePublicSnapshot(await c.req.json());
      await profileStore.saveSnapshot(identity.subject, snapshot);
      return c.json({ ok: true, generated_at: snapshot.generated_at });
    } catch (error) {
      if (error instanceof InvalidSnapshotError) return c.json({ error: error.message }, 400);
      if (error instanceof StaleSnapshotError) return c.json({ error: error.message }, 409);
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid body' }, 400);
      throw error;
    }
  });

  const privateSessions = async (identity: AuthIdentity) => {
    const snapshot = await profileStore.getPrivateAnalytics(identity.subject);
    return snapshot?.sessions || null;
  };

  app.put('/api/me/analytics', async (c) => {
    if (!await waitForProfileStore()) return c.json({ error: 'Profile storage unavailable' }, 503);
    const identity = c.get('identity');
    await ensureSharing(identity);
    try {
      const snapshot = validatePrivateAnalyticsSnapshot(await c.req.json());
      await profileStore.savePrivateAnalytics(identity.subject, snapshot);
      const aggregate = await profileStore.getPrivateAnalytics(identity.subject);
      if (!aggregate) throw new Error('Synchronized analytics were not stored');
      // Public data is derived server-side from the same source of truth; raw session data never reaches public routes.
      await profileStore.saveSnapshot(identity.subject, buildPublicSnapshot(aggregate.sessions, 'details'));
      return c.json({ ok: true, generated_at: snapshot.generated_at, sessions: snapshot.sessions.length, history_included: snapshot.history_included });
    } catch (error) {
      if (error instanceof InvalidPrivateSnapshotError) return c.json({ error: error.message }, 400);
      if (error instanceof StaleSnapshotError) return c.json({ error: error.message }, 409);
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid body' }, 400);
      throw error;
    }
  });

  app.get('/api/me/analytics/summary', async (c) => {
    const sessions = await privateSessions(c.get('identity'));
    if (!sessions) return c.json({ error: 'No synchronized analytics. Run harness-analyzer sync on your computer.' }, 404);
    return c.json(buildSummary(sessions));
  });
  app.get('/api/me/analytics/sessions', async (c) => {
    const sessions = await privateSessions(c.get('identity'));
    if (!sessions) return c.json({ error: 'No synchronized analytics. Run harness-analyzer sync on your computer.' }, 404);
    const filtered = filterSessions(sessions, {
      source: c.req.query('source'), model: c.req.query('model'), from: c.req.query('from'), to: c.req.query('to'),
      minCost: c.req.query('minCost') ? parseFloat(c.req.query('minCost')!) : undefined,
    });
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
    const sorted = filtered.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
    return c.json({ total: filtered.length, sessions: sorted.slice(offset, offset + limit) });
  });
  app.get('/api/me/analytics/sessions/:id', async (c) => {
    const sessions = await privateSessions(c.get('identity'));
    if (!sessions) return c.json({ error: 'No synchronized analytics. Run harness-analyzer sync on your computer.' }, 404);
    const session = getSessionById(sessions, c.req.param('id'));
    return session ? c.json(session) : c.json({ error: 'Not found' }, 404);
  });
  app.get('/api/me/analytics/projects', async (c) => {
    const sessions = await privateSessions(c.get('identity'));
    if (!sessions) return c.json({ error: 'No synchronized analytics. Run harness-analyzer sync on your computer.' }, 404);
    return c.json(getPrivateProjectStats(sessions));
  });
  app.get('/api/me/analytics/charts/daily', async (c) => {
    const sessions = await privateSessions(c.get('identity')); if (!sessions) return c.json({ error: 'No synchronized analytics.' }, 404);
    return c.json(getDailyChart(sessions, parseInt(c.req.query('days') || '30', 10) || 30));
  });
  app.get('/api/me/analytics/charts/daily-models', async (c) => {
    const sessions = await privateSessions(c.get('identity')); if (!sessions) return c.json({ error: 'No synchronized analytics.' }, 404);
    return c.json(getDailyModelChart(sessions, parseInt(c.req.query('days') || '30', 10) || 30));
  });
  app.get('/api/me/analytics/charts/history', async (c) => {
    const sessions = await privateSessions(c.get('identity')); if (!sessions) return c.json({ error: 'No synchronized analytics.' }, 404);
    const rawDays = parseInt(c.req.query('days') || '30', 10);
    return c.json(getHistoryChart(sessions, { timeframe: c.req.query('timeframe') === '1h' ? '1h' : '1d', groupBy: c.req.query('groupBy') === 'model' ? 'model' : 'harness', days: Number.isNaN(rawDays) ? 30 : Math.max(0, rawDays) }));
  });
  app.get('/api/me/analytics/charts/heatmap', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getHeatmapData(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/devices', async (c) => {
    const devices = await profileStore.getPrivateAnalyticsDevices(c.get('identity').subject);
    if (devices.length === 0) return c.json({ error: 'No synchronized analytics.' }, 404);
    const entries = devices.map(({ device, last_synced_at, snapshot }) => {
      const sessions = filterSessions(snapshot.sessions, { from: c.req.query('from'), to: c.req.query('to') });
      return {
        id: device.id,
        name: device.name,
        platform: device.platform,
        architecture: device.architecture,
        last_synced_at,
        cost: parseFloat(sessions.reduce((total, session) => total + session.cost, 0).toFixed(4)),
        tokens: sessions.reduce((total, session) => total + session.input_tokens + session.output_tokens + session.cache_read + session.cache_write, 0),
        sessions: sessions.length,
      };
    });
    entries.sort((left, right) => right.cost - left.cost || right.tokens - left.tokens || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return c.json(entries);
  });
  app.get('/api/me/analytics/charts/sources', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getSourceStats(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/source-usage', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getSourceUsage(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/models', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getModelStats(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/model-usage', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getModelUsage(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/hourly', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getHourlyStats(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/cache', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getCacheStats(filterSessions(sessions, { from: c.req.query('from'), to: c.req.query('to') }))) : c.json({ error: 'No synchronized analytics.' }, 404); });
  app.get('/api/me/analytics/charts/cache-expiry', async (c) => { const sessions = await privateSessions(c.get('identity')); return sessions ? c.json(getCacheExpiryStats(sessions, { from: c.req.query('from'), to: c.req.query('to') })) : c.json({ error: 'No synchronized analytics.' }, 404); });

  app.get('/api/me/public-snapshot-source', (c) => {
    const identity = c.get('identity');
    if (!snapshotExportEnabled && (!snapshotExportOwnerSubject || identity.subject !== snapshotExportOwnerSubject)) {
      return c.json({ error: 'Snapshot export is disabled' }, 403);
    }
    const level = c.req.query('level') || 'totals';
    if (level !== 'totals' && level !== 'details') return c.json({ error: 'Invalid level' }, 400);
    const data = dataProvider();
    if (!data) return c.json({ loading: true }, 503);
    return c.json(buildPublicSnapshot(data.sessions, level));
  });

  app.get('/api/models/pricing', async (c) => {
    try {
      const modelPrices = await pricing.getModelPricing({
        force: c.req.query('refresh') === '1',
      });
      return c.json(modelPrices);
    } catch {
      return c.json({ error: 'OpenRouter pricing is unavailable' }, 502);
    }
  });

app.get('/api/summary', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(data.summary);
});

app.get('/api/sessions', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const filtered = filterSessions(data.sessions, {
    source: c.req.query('source'),
    model: c.req.query('model'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    minCost: c.req.query('minCost') ? parseFloat(c.req.query('minCost')!) : undefined,
  });
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const sorted = filtered.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  return c.json({
    total: filtered.length,
    sessions: sorted.slice(offset, offset + limit),
  });
});

app.get('/api/sessions/:id', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const session = getSessionById(data.sessions, c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  return c.json(session);
});

app.get('/api/projects', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(getProjectStats(data.sessions));
});

app.get('/api/charts/daily', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const days = parseInt(c.req.query('days') || '30');
  return c.json(getDailyChart(data.sessions, days));
});

app.get('/api/charts/daily-models', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const days = parseInt(c.req.query('days') || '30');
  return c.json(getDailyModelChart(data.sessions, days));
});

app.get('/api/charts/history', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const timeframe = c.req.query('timeframe') === '1h' ? '1h' : '1d';
  const groupBy = c.req.query('groupBy') === 'model' ? 'model' : 'harness';
  const rawDays = parseInt(c.req.query('days') || '30');
  const days = Number.isNaN(rawDays) ? 30 : Math.max(0, rawDays);
  return c.json(getHistoryChart(data.sessions, { timeframe, groupBy, days }));
});

app.get('/api/charts/heatmap', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getHeatmapData(sessions));
});

app.get('/api/charts/sources', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getSourceStats(sessions));
});

app.get('/api/charts/source-usage', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getSourceUsage(sessions));
});

app.get('/api/charts/models', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getModelStats(sessions));
});

app.get('/api/charts/model-usage', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getModelUsage(sessions));
});

app.get('/api/charts/hourly', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getHourlyStats(sessions));
});

app.get('/api/charts/cache', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getCacheStats(sessions));
});

app.get('/api/charts/cache-expiry', (c) => {
  const data = dataProvider();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(getCacheExpiryStats(data.sessions, {
    from: c.req.query('from'),
    to: c.req.query('to'),
  }));
});

app.post('/api/collect', (c) => {
  const result = refreshData();
  return c.json({ message: 'Data refreshed', sessions: result.sessions.length });
});

  return app;
}

const app = createApp();

const port = parseInt(process.env.PORT || '3001');
const hostname = process.env.HOST || '127.0.0.1';

if (process.env.NODE_ENV !== 'test') {
  // Start server immediately, collect data in background
  startBackgroundCollect();
  console.log(`Claude Stats API running on http://${hostname}:${port}`);
  serve({ fetch: app.fetch, port, hostname });
}
