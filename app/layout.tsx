import type { Metadata } from "next";
import { Be_Vietnam_Pro, Lora } from "next/font/google";
import "./globals.css";

const lora = Lora({
    variable: "--font-lora",
    subsets: ["latin", "vietnamese"],
    weight: ["400", "500"],
    style: ["normal", "italic"],
    display: "swap",
    fallback: ["Georgia", "serif"],
});

const beVietnamPro = Be_Vietnam_Pro({
    variable: "--font-be-vietnam-pro",
    subsets: ["latin", "vietnamese"],
    weight: ["400", "500"],
    style: ["normal"],
    display: "swap",
    fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = {
    title: "Một bông hoa dành cho bạn",
    description: "Một món quà nhỏ cho ngày 20/10.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
    return (
        <html
            lang="vi"
            className={`${lora.variable} ${beVietnamPro.variable} h-full antialiased`}
        >
            <body className="min-h-full flex flex-col">{children}</body>
        </html>
    );
}

