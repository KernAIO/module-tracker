import { createModuleClient, type KernClientOptions } from '@kernhq/sdk'
import type { ContractRouterClient } from '@orpc/contract'
import type { TrackerContract } from '../contract/index.js'

/**
 * Typed oRPC client for `/api/tracker` (see `../contract`).
 *
 * The shape is generated from the contract, so every procedure, input and output stays in step with
 * the server without a second declaration: if the contract changes, callers stop compiling.
 */
export type TrackerApi = ContractRouterClient<TrackerContract>

export function createTrackerClient(opts: KernClientOptions): TrackerApi {
  return createModuleClient<TrackerApi>(opts, 'tracker')
}
