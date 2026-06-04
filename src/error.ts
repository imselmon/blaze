/**
 * Structured error class for Blaze applications.
 *
 * Carries an HTTP `status` code, a human-readable `message`, and an optional
 * `meta` bag that is spread into the JSON error response by the default error
 * handler.
 *
 * @example
 * ```ts
 * throw new BlazeError(403, 'Forbidden', { code: 'INSUFFICIENT_PERMISSIONS' })
 * ```
 */
export class BlazeError extends Error {
  public readonly status: number;
  public readonly meta: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BlazeError';
    this.status = status;
    this.meta = meta;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
