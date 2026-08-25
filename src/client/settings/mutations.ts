import { toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'

/**
 * A small mutation that refreshes a list and reports its own failures.
 *
 * The planning page has ten of these and they differ only in the call they make, so the shape lives
 * here rather than ten times. It is a `.ts` file because a `<T,>` generic does not survive the
 * Svelte formatter.
 */
export function listMutation<T>(fn: (input: T) => Promise<unknown>, refresh: () => void) {
  const queryClient = useQueryClient()
  void queryClient
  return createMutation(() => ({
    mutationFn: fn,
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  }))
}
