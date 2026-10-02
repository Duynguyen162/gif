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

export type Tab = "single" | "bouquet";

const TABS: { id: Tab; label: string }[] = [
  { id: "single", label: "Một bông" },
  { id: "bouquet", label: "Bó hoa" },
];

export default function Rose2DViewer({ still, initialTab = "single" }: { still: boolean; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div className="relative h-dvh w-full bg-[#1d1d1d] touch-none select-none">
      {tab === "single" ? (
        <Rose2DScene still={still} />
      ) : (
        // keep the bunch clear of the tab bar and the hint
        <BouquetScene still={still} insetTop={still ? 0 : 72} insetBottom={still ? 0 : 40} />
      )}
      {!still && (
        <>
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
                onClick={() => setTab(t.id)}
                className={`rounded-full px-5 py-2 text-sm tracking-wide transition-colors ${
                  tab === t.id ? "bg-[#e9c98a] text-[#2a1f12]" : "text-white/60 hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="pointer-events-none absolute inset-x-0 bottom-6 text-center text-xs tracking-[0.3em] text-white/35 uppercase">
            Di chuột để nghiêng
          </p>
        </>
      )}
    </div>
  );
}
