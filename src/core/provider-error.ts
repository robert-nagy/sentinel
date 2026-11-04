/** Code host (or tool) failure; the CLI maps it to exit code 4. */
export type ProviderErrorKind = 'auth' | 'not-found' | 'unavailable' | 'unsupported' | 'failed';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}
