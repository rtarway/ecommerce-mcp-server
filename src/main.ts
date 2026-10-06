import { createRemoteJWKSet } from "jose";
import { createTokenVerifier } from "./auth/tokens.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { buildShop } from "./shop.js";

const config = loadConfig(process.env);
const app = createApp({
  shop: buildShop(),
  verify: createTokenVerifier({ issuer: config.ISSUER, audience: config.RESOURCE_URL, keySet: createRemoteJWKSet(new URL(config.JWKS_URL)) }),
  resource: config.RESOURCE_URL,
  issuer: config.ISSUER,
  resourceMetadataUrl: config.resourceMetadataUrl,
  debug: config.DEBUG_REQUESTS,
});

app.listen(config.PORT, () => console.log(`ecommerce-mcp-server listening on :${config.PORT}`));
process.on("SIGTERM", () => app.close(() => process.exit(0)));
