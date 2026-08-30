/// <reference types="vite/client" />

/** Injected by vite.config.ts's `define`, from package.json — the single source of truth for the
 *  version shown in Profile's footer (M7.1 prompt §65). */
declare const __APP_VERSION__: string

/** Injected by vite.config.ts's `define` (P83, D-100) — `CF_PAGES_COMMIT_SHA` when built by
 *  Cloudflare Pages, else the locally checked-out commit. See src/platform/build-info.ts. */
declare const __APP_BUILD_SHA__: string

/** Injected alongside `__APP_BUILD_SHA__` — the build's own wall-clock time, ISO 8601. */
declare const __APP_BUILD_TIME__: string
