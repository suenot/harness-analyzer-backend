export interface ModelPrice {
  id: string;
  name: string;
  provider: string;
  contextLength: number | null;
  hasPricingOverrides: boolean;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
}

export interface ModelPricingResponse {
  source: 'OpenRouter';
  fetchedAt: string;
  stale: boolean;
  models: ModelPrice[];
}

export const MODEL_PRICING_TTL_MS = 300_000;

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?limit=1000';
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed * 1_000_000;
}

function contextLength(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeOpenRouterModels(payload: unknown): ModelPrice[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];

  return payload.data
    .filter(isRecord)
    .flatMap((model): ModelPrice[] => {
      if (typeof model.id !== 'string' || !model.id) return [];
      const pricing = isRecord(model.pricing) ? model.pricing : {};
      const [provider = 'unknown'] = model.id.split('/');

      return [{
        id: model.id,
        name: typeof model.name === 'string' && model.name ? model.name : model.id,
        provider,
        contextLength: contextLength(model.context_length),
        hasPricingOverrides: Array.isArray(pricing.overrides) && pricing.overrides.length > 0,
        inputPerMillion: perMillion(pricing.prompt),
        outputPerMillion: perMillion(pricing.completion),
        cacheReadPerMillion: perMillion(pricing.input_cache_read),
        cacheWritePerMillion: perMillion(pricing.input_cache_write),
      }];
    })
    .sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    ));
}

export function createModelPricingService(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
} = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  let snapshot: ModelPricingResponse | null = null;
  let inFlight: Promise<ModelPricingResponse> | null = null;

  async function refresh(): Promise<ModelPricingResponse> {
    const response = await fetcher(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'harness-analyzer model-pricing service',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models request failed: ${response.status}`);
    }

    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error('OpenRouter pricing payload is unavailable');
    }

    const models = normalizeOpenRouterModels(payload);
    if (models.length === 0 || models.length !== payload.data.length) {
      throw new Error('OpenRouter pricing payload is unavailable');
    }

    const fetchedAt = new Date(now()).toISOString();
    const freshSnapshot: ModelPricingResponse = {
      source: 'OpenRouter',
      fetchedAt,
      stale: false,
      models,
    };
    snapshot = freshSnapshot;
    return freshSnapshot;
  }

  async function getModelPricing(options: { force?: boolean } = {}): Promise<ModelPricingResponse> {
    if (!options.force && snapshot && now() - Date.parse(snapshot.fetchedAt) < MODEL_PRICING_TTL_MS) {
      return snapshot;
    }

    if (!inFlight) {
      inFlight = refresh().finally(() => { inFlight = null; });
    }

    try {
      return await inFlight;
    } catch (error) {
      if (snapshot) return { ...snapshot, stale: true };
      throw error;
    }
  }

  return { getModelPricing };
}

export const modelPricingService = createModelPricingService();
