import { redirect } from 'next/navigation';

// /canvas with no trip id used to be a bare 404. Canvases are opened from a
// trip, so send the traveller to their trips instead.
export default function CanvasIndexPage() {
  redirect('/history');
}
