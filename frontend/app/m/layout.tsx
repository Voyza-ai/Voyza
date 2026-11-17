import type { Metadata, Viewport } from 'next';

// The mobile app shell. Installable from the phone's home screen (the
// manifest's start_url is /m, display standalone) and drawn edge to edge,
// with every screen padding itself by the safe-area insets.
export const metadata: Metadata = {
  title: 'BlueMurr',
  manifest: '/m/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'BlueMurr', statusBarStyle: 'default' },
  icons: { apple: '/m/icons/apple-touch-icon.png', icon: '/m/icons/icon-192.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return <div className="m-app min-h-[100dvh]" style={{ background: '#f0f4f8' }}>{children}</div>;
}
