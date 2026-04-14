import { NextResponse } from 'next/server';

export async function GET() {
  // TODO: Fetch trips from Supabase
  return NextResponse.json({ trips: [] });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    // TODO: Save trip to Supabase
    return NextResponse.json({ success: true, trip: body });
  } catch (error) {
    console.error('Trip save error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save trip' },
      { status: 500 }
    );
  }
}
