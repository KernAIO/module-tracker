import { getHost } from '@kernhq/ui'
import { createTrackerClient, type TrackerApi } from './api.js'
import { createMockTrackerApi } from './mock.js'

/**
 * The tracker API client.
 *
 * A module is reached at `/api/<module>`, so every module gets its own client built from its own
 * contract; this is the tracker's, alongside `getApi()` for core. `PUBLIC_API_MOCK=1` swaps in the
 * in-memory implementation from `./mock`, which satisfies the same contract types, so no view has a
 * second code path for demos and end-to-end tests.
 */
export type { TrackerApi }

let cached: TrackerApi | null = null

export function getTrackerApi(): TrackerApi {
  if (cached) return cached
  cached = getHost().isMock ? (createMockTrackerApi() as unknown as TrackerApi) : createReal()
  return cached
}

function createReal(): TrackerApi {
  return createTrackerClient({
    // empty base URL keeps requests same-origin: the dev server proxies /api, and in production the
    // reverse proxy routes it, so the session cookie works without CORS in both
    baseUrl: getHost().apiBaseUrl,
  })
}

/** Test seam: lets tests install a fake without touching module state elsewhere. */
export function __setTrackerApi(api: TrackerApi | null) {
  cached = api
}
