import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeleteAccountModal from '@/components/shared/DeleteAccountModal';
import {
  getCurrentUser,
  requestAccountDeletion,
  cancelAccountDeletion,
} from '@/lib/api';

const mockedMe = getCurrentUser as jest.MockedFunction<typeof getCurrentUser>;
const mockedDelete = requestAccountDeletion as jest.MockedFunction<typeof requestAccountDeletion>;
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
    confirmationSent: true,
    alreadyScheduled: false,
    accountStatus: 'active',
    email: 'test@test.com',
    expiresAt: '2026-09-30T00:00:00Z',
  });
  mockedCancel.mockResolvedValue({ success: true });
});

describe('DeleteAccountModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<DeleteAccountModal isOpen={false} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockedMe).not.toHaveBeenCalled();
  });

  it('active account: deleting only emails a confirmation link (step 1 of 2)', async () => {
    render(<DeleteAccountModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByText('Delete your account?')).toBeInTheDocument();
    expect(screen.getByText(/30-day grace period/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Email me a confirmation link'));
    await waitFor(() => expect(mockedDelete).toHaveBeenCalled());
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(screen.getByText('test@test.com')).toBeInTheDocument();
    expect(screen.queryByText('Deletion scheduled')).not.toBeInTheDocument();
  });

  it('shows the server message when the email could not be sent', async () => {
    mockedDelete.mockRejectedValue(new Error("We couldn't send the confirmation email."));
    render(<DeleteAccountModal isOpen onClose={jest.fn()} />);
    fireEvent.click(await screen.findByText('Email me a confirmation link'));
    expect(await screen.findByText(/couldn't send the confirmation email/)).toBeInTheDocument();
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
