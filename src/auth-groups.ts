export interface AuthGroup {
  id: string;
  name: string;
  member_count: number;
  is_owner: boolean;
}

export type AuthGroupsProvider = (token: string) => Promise<AuthGroup[]>;

export const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuthGroupsProvider(
  apiUrl = process.env.AUTH_API_URL || 'https://auth.marketmaker.cc/api/v1',
  fetcher: typeof fetch = fetch,
): AuthGroupsProvider {
  return async token => {
    const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/groups`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Auth groups unavailable');
    const data = await response.json() as { groups?: unknown };
    if (!Array.isArray(data.groups)) throw new Error('Invalid auth groups response');
    return data.groups.map((group: Record<string, unknown>) => {
      if (!group || typeof group.id !== 'string' || !GROUP_ID_RE.test(group.id)
          || typeof group.name !== 'string' || !Number.isInteger(group.member_count)
          || typeof group.is_owner !== 'boolean') throw new Error('Invalid auth group');
      return {
        id: group.id.toLowerCase(), name: group.name,
        member_count: group.member_count as number, is_owner: group.is_owner,
      };
    });
  };
}
