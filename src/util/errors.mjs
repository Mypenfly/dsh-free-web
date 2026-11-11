/**
 * Error type carrying the machine-routable `code` the DSH web seam expects.
 *
 * The seam's own `WebError` lives in `@deepseek-ai/dsh-web`, which a plugin loaded
 * by absolute path cannot resolve (its `node_modules` is the host's, not ours).
 * Consumers only read `message` and `code`, so a same-shaped Error is enough.
 */

export class FreeWebError extends Error {
  /**
   * @param {string} message human-readable failure
   * @param {string} code stable failure class, e.g. `WEB_PROVIDER_ERROR`
   * @param {ErrorOptions} [options] standard `cause` chaining
   */
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

/** Build a provider failure (`WEB_PROVIDER_ERROR`). */
export const providerError = (message, cause) =>
  new FreeWebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })

/** Build a cancellation error (`WEB_ABORTED`). */
export const abortedError = (message, cause) =>
  new FreeWebError(message, 'WEB_ABORTED', cause === undefined ? undefined : { cause })
