export interface Challenge {
  resourceMetadataUrl: string;
  scope?: string;
  error?: "invalid_token" | "insufficient_scope" | "insufficient_user_authentication" | "invalid_dpop_proof";
  /** RFC 9470: ask the client to re-authenticate the user if the last login is older than this many seconds. */
  maxAge?: number;
  /** Use the DPoP scheme in the challenge (tells clients the token must be sender-constrained). */
  dpop?: boolean;
  /** RFC 6750 `error_description`: what the customer should do, in words an agent can relay. */
  description?: string;
}

/** RFC 6750 / RFC 9728 challenge; MCP clients use it to discover the AS and the scope to request. */
export function wwwAuthenticate({ resourceMetadataUrl, scope, error, maxAge, dpop, description }: Challenge): string {
  const parts = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${resourceMetadataUrl}"`,
    ...(scope ? [`scope="${scope}"`] : []),
    ...(maxAge !== undefined ? [`max_age="${maxAge}"`] : []),
    ...(dpop ? [`algs="ES256 PS256"`] : []),
    ...(description ? [`error_description="${description.replace(/["\\]/g, "")}"`] : []),
  ];
  return `${dpop ? "DPoP" : "Bearer"} ${parts.join(", ")}`;
}
