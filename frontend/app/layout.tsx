import type { Metadata } from 'next';
import '@/styles/globals.css';
import AuthProvider from '@/components/shared/AuthProvider';
import LeaveGuardModal from '@/components/shared/LeaveGuardModal';
import { SITE_URL } from '@/lib/site';
import PageviewTracker from '@/components/shared/PageviewTracker';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'BlueMurr — The Smartest Way to Travel',
  description:
    'Less money, less searching, more vibes. BlueMurr finds the cheapest way to take any trip — optimizing across flights and trains simultaneously.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-voyza-bg text-gray-900 antialiased">
        <AuthProvider>
          {children}
          <LeaveGuardModal />
          <PageviewTracker />
        </AuthProvider>
      </body>
    </html>
  );
}
