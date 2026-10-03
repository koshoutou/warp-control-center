import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WARP 控制中心 — seiry/cloudflare-warp-proxy 的 Node.js 重写版",
  description:
    "Cloudflare WARP 代理的 Node.js 重写版：原生 SOCKS5/HTTP 代理（去除 socat 双跳），warp-svc 进程守护，实时监控面板。极低占用，可完整部署。",
  keywords: [
    "Cloudflare WARP",
    "WARP 代理",
    "SOCKS5",
    "Node.js",
    "seiry/cloudflare-warp-proxy",
    "MASQUE",
    "代理",
  ],
  authors: [{ name: "Inkcoo" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
