# VoxCPM Tunisian speech API

This optional GPU service adapts the `Code-Quasar/voxcpm-tn` model for the existing Cloudflare voice Worker. It is not enabled by default and does not change the current production voice path.

## No-cost-first hosting option: Modal serverless GPU

Modal's Starter plan currently advertises $30 of free compute credit per month, including T4 GPU tasks. It requires a payment method for GPU usage, so set the workspace's **monthly spend limit to $0** before deploying. The service will stop serving VoxCPM when the included credits are exhausted instead of charging beyond them. This is a bounded free tier, not unlimited compute: requests may fail for the rest of the billing period after the credit cap is reached, and cloud GPU capacity/cold starts are not guaranteed.

At the listed T4 rate ($0.000164/second), a 44-second inference uses about $0.0072 of GPU time before CPU/RAM and other metered resources. Actual monthly capacity will therefore be lower than a GPU-only estimate. The model's Hugging Face cache is kept in a Modal Volume to avoid downloading its ~9.5 GB weights on each cold start. The API uses the model card's exact `(Tunisian Dialect)` tag and the settings from the tested Colab samples.

### Deploy

1. Create a free Modal account and install its CLI: `python -m pip install modal`, then `modal setup`.
2. In Modal **Usage & Billing**, set the monthly spend limit to **$0**. Confirm the workspace has its included monthly credits; do not raise the limit to continue after those credits run out.
3. Generate a random secret (at least 32 characters) and create a Modal secret named `clash-voice-secret` with key `VOXCPM_API_TOKEN` using the Modal dashboard's Secrets page.
4. In PowerShell, change to `C:\Users\Asser\Downloads\clash-mobile\backend\voice\voxcpm-api` and run `modal deploy modal_app.py`. The command prints the HTTPS API URL.
5. Configure that URL and the same token as Cloudflare Worker secrets `VOXCPM_API_URL` and `VOXCPM_API_TOKEN`. Keep `VOXCPM_TTS_ENABLED` false until you have tested `/health` and `/voix` and approved the sound.

The Modal endpoint is public but requires the bearer secret. Do not put that secret in website or Android code. The Worker keeps it server-side and already rate-limits voice requests. Clash text sent to the API is processed by Modal; do not enable the integration until that external processing is acceptable for your privacy notice.

### Alternative: Hugging Face ZeroGPU

ZeroGPU can also be connected to the Cloudflare voice Worker as a shared, best-effort backend. If the Worker sends your Hugging Face token with each request, **all Clash AI users share and consume the quota of that one account**; this does not give each user a separate quota or remove ZeroGPU's limits. The currently documented quota is 5 minutes/day for a free account (40 minutes/day for PRO), and queue priority depends on remaining quota. See [Hugging Face's current ZeroGPU/API documentation](https://huggingface.co/docs/hub/en/spaces-zerogpu).

To enable the optional integration:

1. Deploy the Gradio ZeroGPU Space from `zerogpu/` with the `synthesize` API endpoint enabled. Keep the Space public; use an account token only in the Cloudflare Worker, never in browser or Android code.
2. Add the ZeroGPU Space URL as the Worker variable `HF_VOXCPM_SPACE_URL` (for example, `https://<space-subdomain>.hf.space`).
3. Add a Hugging Face **read** token to the Worker secret `HF_VOXCPM_TOKEN` using `wrangler secret put HF_VOXCPM_TOKEN` from `backend/voice/`.
4. Keep `HF_VOXCPM_TTS_ENABLED` set to `false` and `VOXCPM_ROLLOUT_PERCENT` at `0` during setup. The app is configured to fail closed: users keep the text, and no Arabic/French/system voice is substituted when VoxCPM is unavailable. Do not widen the cohort until listening tests pass with Tunisian reviewers. Every cache miss uses the same account's shared quota; cached identical text avoids another GPU request.
5. After private listening tests, set the token secret, enable `HF_VOXCPM_TTS_ENABLED`, and raise `VOXCPM_ROLLOUT_PERCENT` gradually (for example 1, 5, 20, then 100). Return it to `0` immediately to stop the pilot. Check `/health`, queue delay, error codes and Cloudflare Worker logs after each step.

This setup is best-effort and not a stable or unlimited voice service. Do not expose the token or put it in the client app. Clash text is sent to the Hugging Face Space for synthesis; account for this in the privacy notice.

## Requirements

- A persistent CUDA host with enough GPU memory for the model (the tested Colab T4 has 16 GB; the local GTX 1650 with 4 GB is insufficient).
- Python 3.10 or 3.11, a CUDA-compatible PyTorch installation, and the packages in `requirements.txt`.
- An HTTPS reverse proxy in front of the service. Do not expose the API directly to the public internet.
- A random `VOXCPM_API_TOKEN` of at least 32 characters, configured as a secret both here and in the Cloudflare Worker.

## Run

Install a PyTorch build matching the host's CUDA driver, then install `requirements.txt`. Set `VOXCPM_API_TOKEN` and optionally `VOXCPM_MODEL_ID`, then start:

```powershell
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

The first startup downloads the model weights. `/health` reports readiness; `POST /v1/audio/speech` accepts `{ "text": "..." }` in Arabic script and returns a WAV. Requests are serialized because one GPU model instance is loaded in memory.

## Cloudflare Worker wiring

Keep `VOXCPM_TTS_ENABLED` set to `false` unless an independently managed HTTPS service has passed phrase-level review. The production policy in `wrangler.toml` is `voxcpm_only`; no other voice provider is used for playback.

VoxCPM-tn is listed as Apache-2.0 on its [Hugging Face model card](https://huggingface.co/Code-Quasar/voxcpm-tn). ZeroGPU free quota and request capacity are finite; the pilot gate prevents silent substitution and lets operators stop rollout immediately. Model/cache version is set by `VOXCPM_CACHE_VERSION`; bump it when validating a new configuration so old cached audio and approved references remain untouched.
