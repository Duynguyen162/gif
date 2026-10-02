"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

// WebGL only exists in the browser, so skip prerendering the canvas.
const Rose2DScene = dynamic(() => import("./Rose2DScene"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#1d1d1d]" />,
});
const BouquetScene = dynamic(() => import("./BouquetScene"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#1d1d1d]" />,
});
const GiftScene = dynamic(() => import("./GiftScene"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#1d1d1d]" />,
});

export type Tab = "single" | "bouquet" | "gift";

const TABS: { id: Tab; label: string }[] = [
  { id: "single", label: "Một bông" },
  { id: "bouquet", label: "Bó hoa" },
  { id: "gift", label: "Món quà" },
];

export default function Rose2DViewer({ still, initialTab = "single", giftAt }: { still: boolean; initialTab?: Tab; giftAt?: number }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  // 0: the gift is still wrapped; each tap opens it again from the start
  const [play, setPlay] = useState(giftAt === undefined ? 0 : 1);
  const [giftDone, setGiftDone] = useState(false);
  const wrap = () => {
    setPlay(0);
    setGiftDone(false);
  };
  const showTilt = tab !== "gift" || giftDone || still;
  return (
    <div className="relative h-dvh w-full bg-[#1d1d1d] touch-none select-none">
      {tab === "single" && <Rose2DScene still={still} />}
      {/* keep the bunch and the gift clear of the tab bar and the hint */}
      {tab === "bouquet" && <BouquetScene still={still} insetTop={still ? 0 : 72} insetBottom={still ? 0 : 40} />}
      {tab === "gift" && (
        <GiftScene
          still={still}
          play={play}
          freezeAt={giftAt}
          insetTop={still ? 0 : 72}
          insetBottom={still ? 0 : 48}
          onDone={() => setGiftDone(true)}
        />
      )}
      {!still && (
        <>
          {tab === "gift" && play === 0 && (
            <button
              type="button"
              aria-label="Mở quà"
              onClick={() => setPlay((n) => n + 1)}
              className="absolute inset-0 flex cursor-pointer items-end justify-center pb-6"
            >
              <span className="animate-pulse text-xs tracking-[0.3em] text-[#e9c98a]/80 uppercase">Chạm để mở quà</span>
            </button>
          )}
          <div
            role="tablist"
            aria-label="Chọn kiểu hoa"
            className="absolute top-5 left-1/2 flex -translate-x-1/2 gap-1 rounded-full border border-white/10 bg-white/5 p-1 backdrop-blur-md"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  if (t.id === "gift") wrap();
                }}
                className={`rounded-full px-5 py-2 text-sm tracking-wide transition-colors ${
                  tab === t.id ? "bg-[#e9c98a] text-[#2a1f12]" : "text-white/60 hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "gift" && giftDone && (
            <button
              type="button"
              onClick={wrap}
              className="absolute right-5 bottom-5 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs tracking-wide text-white/60 backdrop-blur-md transition-colors hover:text-white"
            >
              Xem lại
            </button>
          )}
          {showTilt && (
            <p className="pointer-events-none absolute inset-x-0 bottom-6 text-center text-xs tracking-[0.3em] text-white/35 uppercase">
              Di chuột để nghiêng
            </p>
          )}
        </>
      )}
    </div>
  );
}
