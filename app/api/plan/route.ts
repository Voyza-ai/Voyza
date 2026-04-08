import { NextResponse } from 'next/server';
import { mockTrip } from '@/lib/mockData';
// import { SYSTEM_PROMPT } from '@/lib/anthropic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    console.log('Planning request:', body);

    // TODO: Replace with actual Anthropic API call when ready
    // For now, return mock data with a slight delay to simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1500));

    return NextResponse.json({
      success: true,
      trip: {
        ...mockTrip,
        id: `trip-${Date.now()}`,
        travelers: body.travelers || 2,
      },
    });
  } catch (error) {
    console.error('Planning error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to plan trip' },
      { status: 500 }
    );
  }
}
