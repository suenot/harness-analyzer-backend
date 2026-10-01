# @harness-analyzer/backend

Profile sharing has two independent settings: `visibility` (`private`, `totals`,
`details`) controls the published data, and `audience` (`public`, `selected`)
controls who can read it. A selected audience accepts `allowed_emails` and
`allowed_group_ids` through `PUT /api/me/sharing`. Friend emails match the
signed-in user's verified auth-service identity. Group IDs must come from the
owner's current memberships, listed by `GET /api/me/sharing/groups`.

Shared dashboard, Sessions and Projects endpoints enforce the same audience.
The auth-service groups API checks current membership on every group-based
read, so leaving or deleting a group revokes that access without a new login.
If the groups API is unavailable, group-based reads fail closed. Selected
profiles never enter the public leaderboard, and recipient lists are returned
only to the owner. Existing profiles keep their previous privacy settings.

`AUTH_API_URL` defaults to `https://auth.marketmaker.cc/api/v1` and configures
the server-side groups API. JWT issuer and JWKS remain separately configurable
through `AUTH_ISSUER` and `AUTH_JWKS_URL`.
