/**
 * Issue a one-time code for a REAL trip, as the website's "Text your trip"
 * panel will (that panel isn't built yet). Writes ONE row to
 * public.text_link_codes (migration 016). Checks the user is on the trip.
 *
 *   NODE_USE_ENV_PROXY=1 SUPABASE_KEY_VIA_PROXY=true SUPABASE_SERVICE_ROLE_KEY=proxy-injected \
 *   SUPABASE_URL=https://<ref>.supabase.co npx tsx src/scripts/textbotLinkCode.ts <tripId> <userId> link|verify
 */
import { SupabaseTextStore } from '../services/textbot/supabaseStore';
import { SupabaseTripLoader } from '../services/textbot/tripLoader';

async function main() {
  const [tripId, userId, kind = 'link'] = process.argv.slice(2);
  if (!tripId || !userId || (kind !== 'link' && kind !== 'verify')) {
    throw new Error('usage: textbotLinkCode.ts <tripId> <userId> link|verify');
  }
  const role = (await new SupabaseTripLoader().members(tripId)).get(userId);
  if (!role) throw new Error('That user is not on that trip (owner or accepted member).');
  if (kind === 'link' && role === 'viewer') throw new Error('Viewers can verify but not link.');
  const c = await new SupabaseTextStore().createCode(kind, tripId, userId, 24 * 3_600_000);
  console.log(`Text this into the chat: ${kind} ${c.code}   (valid 24 h, single use; role ${role})`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
