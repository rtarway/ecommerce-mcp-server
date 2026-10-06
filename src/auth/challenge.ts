export interface Challenge {
  resourceMetadataUrl: string;
  scope?: string;
  error?: "invalid_token" | "insufficient_scope";
}

/** RFC 6750 / RFC 9728 challenge; MCP clients use it to discover the AS and the scope to request. */
export function wwwAuthenticate({ resourceMetadataUrl, scope, error }: Challenge): string {
  const parts = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${resourceMetadataUrl}"`,
    ...(scope ? [`scope="${scope}"`] : []),
  ];
  return `Bearer ${parts.join(", ")}`;
}
