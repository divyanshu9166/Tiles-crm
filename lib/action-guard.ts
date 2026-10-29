import { actionError } from '@/lib/erp/actor'

// Server actions that throw leave the screen waiting forever (the browser gets
// an opaque 500 and the loading spinner never clears). This turns an uncaught
// throw into the { success: false, error } shape the screens already handle.

const isFrameworkSignal = (error: unknown) => {
  const digest = (error as { digest?: unknown } | null)?.digest
  // redirect(), notFound() and dynamic-rendering signals must reach Next.js.
  return typeof digest === 'string' && /^(NEXT_|DYNAMIC_SERVER_USAGE|BAILOUT)/.test(digest)
}

// What a person should read. Database errors never leak table or query text.
export function friendlyError(error: unknown) {
  const code = (error as { code?: string } | null)?.code
  const name = (error as { name?: string } | null)?.name || ''
  if (code === 'P2002') return 'That already exists. Use a different value and try again.'
  if (code === 'P2003') return 'This is linked to other records, so it cannot be changed or removed.'
  if (code === 'P2025') return 'This record no longer exists. Refresh and try again.'
  if (code === 'P2028' || code === 'P2024') return 'The system is busy. Please try again in a moment.'
  const message = error instanceof Error ? error.message : ''
  if (name.startsWith('PrismaClient') || /Invalid `prisma\.|Invalid `tx\.|Unknown argument|Unique constraint failed|Foreign key constraint/.test(message)) {
    return 'Something went wrong while saving. Please try again.'
  }
  return actionError(error, 'Something went wrong. Please try again.')
}

export async function guarded<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isFrameworkSignal(error)) throw error
    const message = friendlyError(error)
    // Expected refusals ("Forbidden", validation) are not worth a stack trace.
    if (!['Unauthorized', 'Forbidden'].includes(error instanceof Error ? error.message : '')) console.error(`[action:${name}]`, error)
    return { success: false, error: message } as unknown as T
  }
}
