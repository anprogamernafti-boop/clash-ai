/* Compatibility entry point. Deploy with backend/gemini/wrangler.toml. */
export {
  default,
  deviceQuotaKey,
  quotaIdentity,
  originAllowed,
  modelAllowed,
  imageTooBig,
  geminiTextFromResponse
} from './backend/gemini/gemini-proxy-worker.js';
