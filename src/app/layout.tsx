import type { Metadata } from "next";
import { Inter, Archivo } from "next/font/google";
import "./globals.css";

// ufirst brand typography (see ufirst_brand_brief.md): Inter for body
// copy app-wide, Archivo exposed as --font-display for headlines/logo
// lockups (used selectively, not app-wide — see globals.css `.font-display`).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["700", "800"],
  style: ["normal", "italic"],
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  title: "Flow by ufirst",
  description: "Invoice approval workflows",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${archivo.variable}`}>
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900">
        {children}
      </body>
    </html>
  );
}
