# Changelog

All notable changes to OmniStudio are documented here.

## [0.3.0] - 2026-09-07

- Image generation: visual style presets with large sample cards and a horizontal scroller (cinematic, storybook, anime, figurine, ink wash, clay, film, product by default). Selecting a card appends a style suffix at generation time for text-to-image and image edit, including restyle-only edits with an empty prompt. Admins can add, edit, reorder, or delete presets and replace sample images and style prompts.
- Uploaded reference, original, and mask images are scaled down to an admin-configured max long edge (default 4096, range 1024–8192) instead of being rejected above 8192. Generated outputs are unchanged.
- Optional Compose overlay `compose.worker.yml` splits the HTTP API and generation worker. Default remains a single `all` process.

## [0.2.0] - 2026-08-28

- Video generation: text-to-video and image-to-video with aspect ratio, duration, and optional resolution.
- Video generation: first-and-last-frame mode. Admins enable it per model; the studio then shows first-frame and last-frame slots. Seedance, Wan, MiniMax, Runway, and Flux already send the two images as first/last frames.
- Provider adapters for OpenAI Videos, Seedance (Volcengine Ark), and Wan (DashScope). Gateways that speak the OpenAI Videos protocol can reuse that adapter.
- Studio switch between image and video; playback, download, regenerate, and retry.
- Video outputs are stored as MP4 with first-frame thumbnails. Video jobs honor configured generation and poll timeouts instead of the previous 60s/120s HTTP caps.
- Connection failures (TCP/TLS) are reported separately from generation timeouts.
- Wan should use `https://dashscope.aliyuncs.com/api/v1`. Workspace hostnames (`*.maas.aliyuncs.com`) can fail TLS on some networks.
- Admin: adapter type moves from the provider to the model. A provider is now only credentials and a Base URL; each model chooses image or video, then an adapter (OpenAI Images / Qwen/Wan / Nano Banana / Seedream / Midjourney / Flux / Runway, or Sora / Seedance / Wan/HappyHorse / Veo / MiniMax / Runway / Flux). One account can host both image and video models.
- Image generation: Qwen-Image (DashScope 千问生图) adapter for text-to-image and reference-image editing (up to 3 reference images) via the native synchronous multimodal-generation API. Mask inpainting is not supported by the upstream API.
- Image generation: Nano Banana (Gemini native image) adapter for text-to-image and reference-image editing via `generateContent`. Same Gemini Base URL and API key as Veo. Mask inpainting is not supported.
- Image generation: Seedream (Volcengine Ark) adapter for text-to-image and reference-image editing via `/images/generations`. Use `https://ark.cn-beijing.volces.com/api/v3`; it can share a provider with Seedance. Mask inpainting is not supported.
- Image generation: Midjourney adapter for text-to-image and image prompts via a midjourney-proxy-compatible gateway (`/mj/submit/imagine` + `/mj/task/{id}/fetch`). There is no official Midjourney API.
- Image generation: Flux (Black Forest Labs) adapter for text-to-image and reference-image editing via `POST /v1/{model}` and `polling_url`. Use `https://api.bfl.ai`; model IDs are BFL paths such as `flux-2-pro`. Mask inpainting is not supported.
- Image generation: Runway adapter for text-to-image and reference-image editing via `/v1/text_to_image`. Use `https://api.dev.runwayml.com` and model IDs such as `gen4_image`; it can share a provider with Runway video. Mask inpainting is not supported.
- Video generation: Veo (Gemini API) adapter for text-to-video and image-to-video via `predictLongRunning`. Use Base URL `https://generativelanguage.googleapis.com/v1beta` and a Google AI Studio API key.
- Video generation: MiniMax adapter for text-to-video and first/last-frame image-to-video via `/v2/video_generation`. Use `https://api.minimaxi.com` (China) or `https://api.minimax.io` (intl) and model ID `MiniMax-H3`.
- Video generation: Runway adapter for text-to-video and image-to-video via `/v1/text_to_video` and `/v1/image_to_video`. Use `https://api.dev.runwayml.com` and model IDs such as `gen4.5`.
- Video generation: Flux video adapter for FLUX 3 (`/v1/flux-3-video`, `t2v` / `i2v`). Shares a BFL provider with Flux images.
- Admin model form replaces the size preset list with tier and ratio inputs. Each resolution tier is a label plus short-edge pixels; point multipliers are keyed per tier.
- Generation quotas are points-based: every model has a points-per-unit price (per image, or per second for video), and group quotas cap points inside a sliding window shared by images and video. Retries re-price with the model's current price.
- Admin: the group quota form uses a window plus points per person; the model form adds a points-per-unit price; the usage ledger, studio sidebar, and model picker show points.
- Prompt polishing supports text-to-video and image editing. Admins can configure multiple polishing providers; only one can be enabled at a time.
- User groups only control model access and generation quotas. Asset sharing moves to work teams, which have their own membership.
- Asset library: server-side filters for media type, generated vs uploaded, model, date range, and note/prompt search. Pagination and totals follow the active filters.
- The generation settings popover now opens directly in its final position (above or below the trigger); it no longer flashes toward the default position first.
- Asset-library bulk download and prompt-polish validation use a short-lived top toast instead of an extra line of text. Success is green; download timeout and polish errors are red.
- Deleted library assets go to a recycle bin. Users can restore them; administrators set the retention period (default 30 days). Files still count against storage until they expire and are permanently removed.

## [0.1.3] - 2026-08-20

- Share assets with user groups; members can preview, download, and use them as edit or inpaint references.
- Shared files stay with the owner. Recipients do not get a copy or extra storage quota. Prompts and notes stay private.
- Per-group sliding-window generation quotas (for example 5 images / 5h). Retries count. Empty settings mean no limit.
- Sidebar usage for storage and remaining group allowances; admin usage query by UTC date range.
- Conversation titles: first 10 characters for Chinese prompts, first 4 words for English prompts.
- Prompt polishing asks for confirmation before calling the model and before replacing the prompt.
- Admin-configurable Chinese and English labels for size and quality values.

## [0.1.2] - 2026-08-20

- AI prompt polishing for text-to-image, with preview and confirmation before apply.
- Admin settings for the polishing LLM (provider, model, endpoint, encrypted API key, timeout, system prompt, connection test).
- Polishing requests are rate-limited, timed out, and fail without replacing the original prompt.

## [0.1.1] - 2026-08-19

- Multi-reference editing and inpainting, mixing local files with history and asset-library images.
- Persistent prompt history and favorites.
- Regenerate restores prompt, model, size, quality, count, and references; inpainting requires a new mask.
- Download all images from a conversation, or selected images from the current asset-library page.

## [0.1.0] - 2026-08-18

- First release: self-hosted image generation with OpenAI Images-compatible providers.
- Text-to-image, reference-image editing, masked inpainting, conversations, and an asset library.
- User approval, groups, model access control, administrator MFA, and encrypted provider keys.
- Chinese and English UI. Video generation is reserved in the codebase but not exposed.
