import { NextResponse } from 'next/server';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Proxy to the real backend
    const res = await fetch(`${BACKEND_URL}/api/plan/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { success: false, error: err.error ?? `Backend error ${res.status}` },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error('Planning error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to plan trip' },
      { status: 500 },
    );
  }
}
