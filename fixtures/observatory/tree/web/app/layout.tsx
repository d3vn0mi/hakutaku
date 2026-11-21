import type { ReactNode } from "react";

export const metadata = {
  title: "Observatory",
  description: "Tonight's sky, and where the planets are.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
