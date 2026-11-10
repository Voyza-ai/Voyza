'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { applyRecommendationsToMyTrips, exportMyData, type UserProfile } from '@/lib/api';
import { SettingsCard, Toggle, SecondaryButton, Status } from './ui';

type Prefs = UserProfile['preferences'];
type Msg = { kind: 'ok' | 'error'; text: string } | null;

/** Hand a Blob to the browser as a file download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PrivacyTab({
  preferences,
  onChange,
  disabled,
}: {
  preferences: Prefs;
  onChange: (patch: Prefs) => void;
  disabled?: boolean;
}) {
  const allow = preferences.privacy?.allowRecommendations !== false;
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMsg, setApplyMsg] = useState<Msg>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<Msg>(null);

  const applyToExisting = async () => {
    setApplyBusy(true);
    setApplyMsg(null);
    try {
      const { updated } = await applyRecommendationsToMyTrips(allow);
      setApplyMsg({
        kind: 'ok',
        text: `${updated} trip${updated === 1 ? '' : 's'} updated — recommendations ${allow ? 'allowed' : 'turned off'}.`,
      });
    } catch (err) {
      setApplyMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not update your trips.' });
    } finally {
      setApplyBusy(false);
    }
  };

  const doExport = async () => {
    setExportBusy(true);
    setExportMsg(null);
    try {
      const { blob, filename } = await exportMyData();
      saveBlob(blob, filename);
      setExportMsg({ kind: 'ok', text: 'Your export has downloaded.' });
    } catch (err) {
      setExportMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not export your data.' });
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SettingsCard title="Recommendations">
        <Toggle
          id="privacy-allowRecommendations"
          label="Allow my trips to be used for recommendations"
          description="BlueMurr can learn from the shape of your trips — cities, dates, budget, vibe — to suggest better routes. Never your name or email. Applies to trips you create from now on."
          checked={allow}
          disabled={disabled}
          onChange={(v) => {
            setApplyMsg(null);
            onChange({ privacy: { allowRecommendations: v } });
          }}
        />
        <div className="flex items-center gap-4 pt-3 mt-1 border-t border-gray-100">
          <SecondaryButton type="button" onClick={applyToExisting} busy={applyBusy} disabled={disabled}>
            Apply to my existing trips
          </SecondaryButton>
          {applyMsg ? (
            <Status kind={applyMsg.kind}>{applyMsg.text}</Status>
          ) : (
            <p className="text-[13px] text-gray-500">Your trips already saved keep their own setting until you do this.</p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Your data"
        description="Download everything we hold about you — profile, preferences, your trips with their cities and transport, and your collaborations — as a JSON file."
      >
        <div className="flex items-center gap-4">
          <SecondaryButton type="button" onClick={doExport} busy={exportBusy}>
            <Download size={14} />
            Export my data
          </SecondaryButton>
          {exportMsg && <Status kind={exportMsg.kind}>{exportMsg.text}</Status>}
        </div>
      </SettingsCard>
    </div>
  );
}
