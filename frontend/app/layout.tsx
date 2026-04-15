import type { Metadata } from 'next';
import '@/styles/globals.css';
import AuthProvider from '@/components/shared/AuthProvider';

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
      <body className="bg-voyza-bg text-gray-900 antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
