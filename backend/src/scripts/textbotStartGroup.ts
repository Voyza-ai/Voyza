/**
 * Blue starts a Twilio group text with the given people (you + friend + Blue).
 *
 *   TWILIO_ACCOUNT_SID=AC… TWILIO_FROM_NUMBER=+1… NODE_USE_ENV_PROXY=1 \
 *     npx tsx src/scripts/textbotStartGroup.ts +1XXXXXXXXXX +1YYYYYYYYYY
 *
 * The auth token is injected by this environment's network proxy (it is never
 * in code or env here). Sends ONE intro text into the new group. Real texts,
 * real cost (a few cents).
 */
import { twilioConfigFromEnv } from '../services/textbot/providers/twilio';
import { TwilioGroups } from '../services/textbot/providers/twilioGroups';

async function main() {
  const phones = process.argv.slice(2);
  const cfg = twilioConfigFromEnv();
  if (!cfg) throw new Error('Set TWILIO_ACCOUNT_SID and TWILIO_FROM_NUMBER');
  const groups = new TwilioGroups(cfg);
  const threadId = await groups.createGroup(phones, 'BlueMurr trip');
  await groups.send({
    provider: 'twilio',
    threadId,
    text:
      "Hi, I'm Blue from BlueMurr. To connect this chat to your trip, the trip owner opens the trip, " +
      'taps "Text your trip" and sends the code here as "link CODE". Reply STOP to opt out.',
  });
  console.log(`Group started: ${threadId}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
