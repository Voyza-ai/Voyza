import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from '@/app/settings/page';
import ConfirmDeletionPage from '@/app/settings/confirm-deletion/page';
import {
  getCurrentUser,
  updateCurrentUser,
  applyRecommendationsToMyTrips,
  exportMyData,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '@/lib/api';

jest.mock('@/components/shared/Navbar', () => ({ __esModule: true, default: () => null }));

const supabaseMock = jest.requireMock('@/lib/supabase').supabase;
supabaseMock.auth.updateUser = jest.fn();
supabaseMock.auth.signInWithPassword = jest.fn();

const me = {
  id: 'u1',
  email: 'test@test.com',
  fullName: 'Ada Lovelace',
  avatarUrl: null,
  isPremium: false,
  preferences: { homeCity: 'London', preferredCurrency: 'GBP', defaultTravelers: 2 },
  accountStatus: 'active' as const,
  scheduledDeletionAt: null,
};

const mocked = <T extends (...a: any[]) => any>(f: T) => f as unknown as jest.MockedFunction<T>;

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Array.from(mockSearchParams.keys())) mockSearchParams.delete(k);
  mocked(getCurrentUser).mockResolvedValue(me);
  mocked(updateCurrentUser).mockImplementation(async (patch: any) => ({
    ...me,
    ...patch,
    preferences: { ...me.preferences, ...(patch.preferences ?? {}) },
  }));
  supabaseMock.auth.updateUser.mockResolvedValue({ data: { user: null }, error: null });
  supabaseMock.auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
});

const openTab = (tab: string) => mockSearchParams.set('tab', tab);

describe('Settings page — Profile', () => {
  it('loads the profile and saves name + preferences', async () => {
    render(<SettingsPage />);
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('Ada Lovelace');
    expect((screen.getByLabelText('Home city') as HTMLInputElement).value).toBe('London');

    const save = screen.getByText('Save changes').closest('button')!;
    expect(save).toBeDisabled(); // nothing changed yet

    fireEvent.change(name, { target: { value: 'Ada King' } });
    fireEvent.change(screen.getByLabelText('Home airport'), { target: { value: 'lhr' } });
    fireEvent.change(screen.getByLabelText('Default travelers'), { target: { value: '3' } });
    fireEvent.click(save);

    await screen.findByText('Profile saved.');
    expect(updateCurrentUser).toHaveBeenCalledWith({
      fullName: 'Ada King',
      avatarUrl: null,
      preferences: { homeCity: 'London', homeAirport: 'LHR', preferredCurrency: 'GBP', defaultTravelers: 3 },
    });
    // Name also synced to auth metadata so the navbar initials update.
    expect(supabaseMock.auth.updateUser).toHaveBeenCalledWith({ data: { full_name: 'Ada King' } });
  });

  it('refuses an empty name without calling the API', async () => {
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(updateCurrentUser).not.toHaveBeenCalled();
  });

  it('the ?tab= param picks the section; unknown values fall back to Profile', async () => {
    openTab('nonsense');
    render(<SettingsPage />);
    await screen.findByLabelText('Name');
    expect(screen.getByRole('tab', { name: /Profile/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Account/ })).toHaveAttribute('aria-selected', 'false');
  });
});

describe('Settings page — Notifications', () => {
  it('shows opt-out defaults and saves a single toggle as a partial patch', async () => {
    openTab('notifications');
    render(<SettingsPage />);
    const invite = await screen.findByTestId('notif-canvas_invite');
    expect(invite).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('email-digest')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(invite);
    expect(invite).toHaveAttribute('aria-checked', 'false'); // optimistic
    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenCalledWith({ preferences: { notifications: { canvas_invite: false } } }),
    );
  });

  it('reverts the toggle and says so when the save fails', async () => {
    openTab('notifications');
    mocked(updateCurrentUser).mockRejectedValueOnce(new Error('offline'));
    render(<SettingsPage />);
    const digest = await screen.findByTestId('email-digest');
    fireEvent.click(digest);
    expect(await screen.findByText(/didn't save/)).toBeInTheDocument();
    expect(digest).toHaveAttribute('aria-checked', 'false');
  });

  it('pausing all email disables the per-type email toggles', async () => {
    openTab('notifications');
    mocked(getCurrentUser).mockResolvedValue({ ...me, preferences: { email: { unsubscribed: true } } } as any);
    render(<SettingsPage />);
    expect(await screen.findByTestId('email-canvas_invite')).toBeDisabled();
    expect(screen.getByTestId('email-unsubscribed')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Settings page — Privacy & data', () => {
  it('toggles the recommendations default and can apply it to existing trips', async () => {
    openTab('privacy');
    mocked(applyRecommendationsToMyTrips).mockResolvedValue({ success: true, updated: 4 });
    render(<SettingsPage />);
    const toggle = await screen.findByTestId('privacy-allowRecommendations');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenCalledWith({ preferences: { privacy: { allowRecommendations: false } } }),
    );
    fireEvent.click(screen.getByText('Apply to my existing trips'));
    await waitFor(() => expect(applyRecommendationsToMyTrips).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/4 trips updated — recommendations turned off/)).toBeInTheDocument();
  });

  it('export downloads the file the API returns', async () => {
    openTab('privacy');
    const createObjectURL = jest.fn(() => 'blob:x');
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = jest.fn();
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<SettingsPage />);
    fireEvent.click(await screen.findByText('Export my data'));
    await screen.findByText('Your export has downloaded.');
    expect(exportMyData).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe('Settings page — Account', () => {
  it('change password re-checks the current password first', async () => {
    openTab('account');
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'old-pass-1' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pass-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pass-123' } });
    fireEvent.click(screen.getByText('Update password'));

    await screen.findByText(/Password updated/);
    expect(supabaseMock.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'test@test.com', password: 'old-pass-1' });
    expect(supabaseMock.auth.updateUser).toHaveBeenCalledWith({ password: 'new-pass-123' });
  });

  it('a wrong current password stops the change', async () => {
    openTab('account');
    supabaseMock.auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login' } });
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pass-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pass-123' } });
    fireEvent.click(screen.getByText('Update password'));
    expect(await screen.findByText('Your current password is incorrect.')).toBeInTheDocument();
    expect(supabaseMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it('mismatched new passwords never reach Supabase', async () => {
    openTab('account');
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-pass-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pass-124' } });
    fireEvent.click(screen.getByText('Update password'));
    expect(await screen.findByText("The new passwords don't match.")).toBeInTheDocument();
    expect(supabaseMock.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('change email goes through supabase.auth.updateUser with a redirect back here', async () => {
    openTab('account');
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('New email'), { target: { value: 'New@Test.com' } });
    fireEvent.click(screen.getByText('Change email'));
    await screen.findByText(/Check new@test.com for a confirmation link/);
    expect(supabaseMock.auth.updateUser).toHaveBeenCalledWith(
      { email: 'new@test.com' },
      { emailRedirectTo: expect.stringMatching(/\/settings\?tab=account$/) },
    );
  });

  it('delete account opens the two-step modal, which only requests the email', async () => {
    openTab('account');
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    fireEvent.click(await screen.findByText('Email me a confirmation link'));
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(requestAccountDeletion).toHaveBeenCalled();
  });

  it('a pending deletion shows its date and a way to keep the account', async () => {
    openTab('account');
    mocked(getCurrentUser).mockResolvedValue({
      ...me,
      accountStatus: 'pending_deletion',
      scheduledDeletionAt: '2026-12-02T12:00:00Z',
    });
    render(<SettingsPage />);
    expect(await screen.findByText('December 2, 2026')).toBeInTheDocument();
    expect(screen.getByText('Keep my account')).toBeInTheDocument();
  });
});

describe('/settings/confirm-deletion', () => {
  it('does nothing on load; schedules only when the button is pressed', async () => {
    mockSearchParams.set('token', 'abc.def');
    render(<ConfirmDeletionPage />);
    expect(confirmAccountDeletion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Delete my account'));
    expect(await screen.findByText('Deletion scheduled')).toBeInTheDocument();
    expect(confirmAccountDeletion).toHaveBeenCalledWith('abc.def');
    expect(screen.getByText(/October 2[89], 2026/)).toBeInTheDocument(); // UTC midnight → local date
  });

  it('shows the server error for a used/expired link', async () => {
    mockSearchParams.set('token', 'abc.def');
    mocked(confirmAccountDeletion).mockRejectedValueOnce(new Error('This confirmation link is invalid or has expired.'));
    render(<ConfirmDeletionPage />);
    fireEvent.click(screen.getByText('Delete my account'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/);
  });

  it('a link with no token says so', () => {
    render(<ConfirmDeletionPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/);
  });
});
