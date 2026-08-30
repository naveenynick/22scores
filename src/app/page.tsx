/**
 * Placeholder landing page.
 *
 * The foundation intentionally ships no product UI yet. This page only
 * confirms the app builds and the design tokens are wired up. Country-first
 * sport pages will be added in a later step.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">22scores</h1>
      <p className="text-muted-foreground">
        Foundation only. Provider abstraction and canonical data model are in
        place; ingestion and UI come next.
      </p>
    </main>
  );
}
