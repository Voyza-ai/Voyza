import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeleteAccountModal from '@/components/shared/DeleteAccountModal';
import {
  getCurrentUser,
  deleteCurrentUser,
  cancelAccountDeletion,
} from '@/lib/api';

const mockedMe = getCurrentUser as jest.MockedFunction<typeof getCurrentUser>;
const mockedDelete = deleteCurrentUser as jest.MockedFunction<typeof deleteCurrentUser>;
const mockedCancel = cancelAccountDeletion as jest.MockedFunction<typeof cancelAccountDeletion>;

const activeMe = {
  id: 'u1',
  email: 'test@test.com',
  fullName: null,
  avatarUrl: null,
  isPremium: false,
  preferences: {},
  accountStatus: 'active' as const,
  scheduledDeletionAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedMe.mockResolvedValue(activeMe);
  mockedDelete.mockResolvedValue({
    success: true,
    accountStatus: 'pending_deletion',
    deletedAt: '2026-09-29T00:00:00Z',
    scheduledDeletionAt: '2026-10-29T12:00:00Z',
    alreadyScheduled: false,
  });
  mockedCancel.mockResolvedValue({ success: true });
});

describe('DeleteAccountModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<DeleteAccountModal isOpen={false} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockedMe).not.toHaveBeenCalled();
  });

  it('active account: shows the grace-period warning and confirms deletion', async () => {
    render(<DeleteAccountModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByText('Delete your account?')).toBeInTheDocument();
    expect(screen.getByText(/30-day grace period/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => expect(mockedDelete).toHaveBeenCalled());
    // Flips to the scheduled view with the real date.
    expect(await screen.findByText('Deletion scheduled')).toBeInTheDocument();
    expect(screen.getByText(/October 29, 2026/)).toBeInTheDocument();
  });

  it('"Keep my account" on the confirm view just closes — no API call', async () => {
    const onClose = jest.fn();
    render(<DeleteAccountModal isOpen onClose={onClose} />);
    await screen.findByText('Delete your account?');

    fireEvent.click(screen.getByText('Keep my account'));
    expect(onClose).toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('pending account: opens straight to the scheduled view and can cancel', async () => {
    mockedMe.mockResolvedValue({
      ...activeMe,
      accountStatus: 'pending_deletion',
      scheduledDeletionAt: '2026-10-15T12:00:00Z',
    });
    const onClose = jest.fn();
    render(<DeleteAccountModal isOpen onClose={onClose} />);

    expect(await screen.findByText('Deletion scheduled')).toBeInTheDocument();
    expect(screen.getByText(/October 15, 2026/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Keep my account'));
    await waitFor(() => expect(mockedCancel).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the error state when the profile fetch fails', async () => {
    mockedMe.mockRejectedValue(new Error('network'));
    render(<DeleteAccountModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
  });
});
