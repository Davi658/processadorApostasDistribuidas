/** Optional authentication extension (challenge section 2).
 * Bind an external OIDC/JWKS adapter and invoke it from a Nest guard on financial
 * HTTP controllers. Health remains public; SQS is a trusted internal channel.
 * No implementation is registered: this delivery intentionally omits authentication.
 */
export interface ProviderIdentityPort {
  authenticate(bearerToken: string): Promise<{ subject: string; providerId: string }>;
}
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
