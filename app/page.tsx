import Rose2DViewer from "./components/rose2d/Rose2DViewer";

export default async function Home({ searchParams }: PageProps<"/">) {
  // ?still=1 turns the effects off (used to verify the picture against the photo)
  // ?tab=bouquet opens on the bouquet
  const { still, tab } = await searchParams;
  return (
    <main className="flex-1 bg-[#1d1d1d]">
      <Rose2DViewer still={still === "1"} initialTab={tab === "bouquet" ? "bouquet" : "single"} />
    </main>
  );
}
