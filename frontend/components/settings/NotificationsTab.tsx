'use client';

import type { MutableNotificationType, UserProfile } from '@/lib/api';
import { SettingsCard, Toggle } from './ui';

type Prefs = UserProfile['preferences'];

const IN_APP: Array<{ type: MutableNotificationType; label: string; description: string }> = [
  { type: 'canvas_invite', label: 'Trip invites', description: 'Someone invites you to plan a trip with them.' },
  { type: 'suggestion_decided', label: 'Suggestion decisions', description: 'A trip owner accepts or declines your suggestion.' },
  { type: 'ownership_transferred', label: 'Ownership transfers', description: 'A trip is handed over to you.' },
  { type: 'trip_owner_anonymized', label: 'Trip owner left', description: "The owner of a trip you're on deleted their account." },
];

export default function NotificationsTab({
  preferences,
  onChange,
  disabled,
}: {
  preferences: Prefs;
  /** Saves a partial preferences patch (optimistic in the parent). */
  onChange: (patch: Prefs) => void;
  disabled?: boolean;
}) {
  const inApp = preferences.notifications ?? {};
  const email = preferences.email ?? {};
  const unsubscribed = email.unsubscribed === true;

  return (
    <div className="space-y-5">
      <SettingsCard title="In-app notifications" description="What shows up in the bell in the top bar.">
        <div className="divide-y divide-gray-100">
          {IN_APP.map((n) => (
            <Toggle
              key={n.type}
              id={`notif-${n.type}`}
              label={n.label}
              description={n.description}
              checked={inApp[n.type] !== false}
              disabled={disabled}
              onChange={(v) => onChange({ notifications: { [n.type]: v } })}
            />
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Email"
        description="Account notices — like deletion confirmations — are always sent, whatever you choose here."
      >
        <div className="divide-y divide-gray-100">
          <Toggle
            id="email-canvas_invite"
            label="Trip invite emails"
            description="An email when someone invites you to a trip."
            checked={!unsubscribed && email.canvas_invite !== false}
            disabled={disabled || unsubscribed}
            onChange={(v) => onChange({ email: { canvas_invite: v } })}
          />
          <Toggle
            id="email-digest"
            label="Weekly digest"
            description="A weekly roundup of unread notifications. Off unless you turn it on."
            checked={!unsubscribed && email.digest === true}
            disabled={disabled || unsubscribed}
            onChange={(v) => onChange({ email: { digest: v } })}
          />
          <Toggle
            id="email-unsubscribed"
            label="Pause all non-essential email"
            description="Overrides the two settings above. Same as the unsubscribe link in our emails."
            checked={unsubscribed}
            disabled={disabled}
            onChange={(v) => onChange({ email: { unsubscribed: v } })}
          />
        </div>
      </SettingsCard>
    </div>
  );
}
