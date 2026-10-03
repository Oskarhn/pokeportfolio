// The shared web modules under ../../src/data include the web client (`supabase-client.ts`) that reads
// `import.meta.env`. Metro/Jest never load that file (the seam redirects it), but the type-checker
// still walks it, so it needs this declaration. Nothing at runtime depends on it.
interface ImportMeta {
  readonly env: Record<string, string | undefined>
}
