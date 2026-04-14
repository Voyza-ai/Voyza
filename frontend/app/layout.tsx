import type { Metadata } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Voyza — The Smartest Way to Travel',
  description:
    'Less money, less searching, more vibes. Voyza finds the cheapest way to take any trip — optimizing across flights and trains simultaneously.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-voyza-bg text-gray-900 antialiased">{children}</body>
    </html>
  );
}
