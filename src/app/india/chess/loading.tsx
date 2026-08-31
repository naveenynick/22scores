import { ChessPageSkeleton } from "@/components/chess/skeleton";

/**
 * Shown while the server render of /india/chess is in flight. The page is
 * always dynamic, so this is what a reader sees on navigation and on a refresh.
 * The skeleton draws its own masthead band, so there is no wrapper here.
 */
export default function Loading() {
  return (
    <main className="min-h-screen pb-16">
      <ChessPageSkeleton />
    </main>
  );
}
