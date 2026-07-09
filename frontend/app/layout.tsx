import type { Metadata } from 'next';
import { Instrument_Serif } from 'next/font/google';
import '@/styles/globals.css';
import AuthProvider from '@/components/shared/AuthProvider';

// Editorial accent face — used for single italic accent words in headlines
// (landing hero). Body/UI stays Inter. Exposed as --font-serif.
const instrumentSerif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

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
      <body className={`${instrumentSerif.variable} bg-voyza-bg text-gray-900 antialiased`}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
