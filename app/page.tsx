import Rose2DViewer, { type Tab } from "./components/rose2d/Rose2DViewer";

const TABS: Tab[] = ["single", "bouquet", "gift"];

export default async function Home({ searchParams }: PageProps<"/">) {
  // ?still=1 turns the effects off (used to verify the picture against the photo)
  // ?tab=bouquet | gift opens on that tab
  // ?gift_t=3.2 holds the gift reveal at that second (for checking a beat)
  const { still, tab, gift_t } = await searchParams;
  const initialTab = TABS.find((t) => t === tab) ?? "single";
  const giftAt = typeof gift_t === "string" && gift_t !== "" && Number.isFinite(Number(gift_t)) ? Number(gift_t) : undefined;
  return (
    <main className="flex-1 bg-[#1d1d1d]">
      <Rose2DViewer still={still === "1"} initialTab={initialTab} giftAt={giftAt} />
    </main>
  );
}
