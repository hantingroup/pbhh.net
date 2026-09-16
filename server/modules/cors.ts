/** Stop remembering origins past this many (see `noteOrigin`). */
const MAX_REMEMBERED_ORIGINS = 100

const seenOrigins = new Set<string>()
let originsOverflowed = false

/**
 * Record cross-origin callers, then let everything through — observe only, don't block.
 *
 * `@elysiajs/cors` defaults to `origin: true` (reflects the request Origin) with
 * `credentials: true`, so any site can make credentialed cross-origin requests and read
 * the response; `SameSite=Lax` is all that's left in the way. This should become an
 * allowlist, but a missed entry fails silently — so log first, to turn "who calls
 * api.pbhh.net" from guesswork into fact, then tighten.
 *
 * Its own file so it can be tested: inline in `index.ts`, a probe would only exercise a
 * copy of it.
 *
 * First sighting only, and capped — `Origin` is caller-controlled, so an unbounded Set
 * is a memory amplifier. Warnings reach the admin log via `admin/logger.ts`.
 */
export function noteOrigin(request: Request) {
  const from = request.headers.get('origin')
  if (!from || seenOrigins.has(from))
    return true

  if (seenOrigins.size >= MAX_REMEMBERED_ORIGINS) {
    if (!originsOverflowed) {
      originsOverflowed = true
      console.warn(`[cors] hit the ${MAX_REMEMBERED_ORIGINS}-origin cap, no longer recording new origins`)
    }
    return true
  }

  seenOrigins.add(from)
  console.warn(`[cors] new cross-origin caller: ${from}`)
  return true
}
