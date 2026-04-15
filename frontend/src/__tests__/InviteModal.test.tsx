import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import InviteModal from '@/components/canvas/InviteModal';
import { inviteToCanvas } from '@/lib/api';

const mockedInvite = inviteToCanvas as jest.MockedFunction<typeof inviteToCanvas>;

beforeEach(() => {
  jest.clearAllMocks();
  // Mock clipboard
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

const baseProps = {
  tripId: 'trip-test-123',
  isOpen: true,
  onClose: jest.fn(),
  members: [] as any[],
};

describe('InviteModal', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(<InviteModal {...baseProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders Share Canvas header when open', () => {
    render(<InviteModal {...baseProps} />);
    expect(screen.getByText('Share Canvas')).toBeInTheDocument();
  });

  it('submits invite with correct email and role', async () => {
    mockedInvite.mockResolvedValue({
      member: { id: 'm1' },
      inviteLink: 'https://voyza.app/invite/abc',
    });

    render(<InviteModal {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText('Email address'), {
      target: { value: 'friend@example.com' },
    });
    fireEvent.click(screen.getByText('Send Invite'));

    await waitFor(() => {
      expect(mockedInvite).toHaveBeenCalledWith(
        'trip-test-123',
        'friend@example.com',
        'editor', // default role
      );
    });
  });

  it('shows invite link after successful invite', async () => {
    mockedInvite.mockResolvedValue({
      member: { id: 'm1' },
      inviteLink: 'https://voyza.app/invite/abc',
    });

    render(<InviteModal {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText('Email address'), {
      target: { value: 'friend@example.com' },
    });
    fireEvent.click(screen.getByText('Send Invite'));

    await waitFor(() => {
      expect(screen.getByText('https://voyza.app/invite/abc')).toBeInTheDocument();
    });
  });

  it('shows error gracefully on API failure', async () => {
    mockedInvite.mockRejectedValue(new Error('Network error'));

    render(<InviteModal {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText('Email address'), {
      target: { value: 'friend@example.com' },
    });
    fireEvent.click(screen.getByText('Send Invite'));

    // Should not crash, button should return to normal state
    await waitFor(() => {
      expect(screen.getByText('Send Invite')).toBeInTheDocument();
    });
  });

  it('renders existing members list with role badges', () => {
    const members = [
      {
        id: 'm1',
        invited_email: 'alice@example.com',
        role: 'editor',
        accepted_at: '2026-06-15T00:00:00Z',
        user_id: 'u1',
      },
      {
        id: 'm2',
        invited_email: 'bob@example.com',
        role: 'viewer',
        accepted_at: null,
        user_id: null,
      },
    ];

    render(<InviteModal {...baseProps} members={members} />);

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText('editor')).toBeInTheDocument();
    expect(screen.getByText('viewer')).toBeInTheDocument();
  });

  it('shows green dot for active members', () => {
    const members = [
      {
        id: 'm1',
        invited_email: 'alice@example.com',
        role: 'editor',
        accepted_at: '2026-06-15T00:00:00Z',
        user_id: 'u1',
      },
    ];

    render(<InviteModal {...baseProps} members={members} />);

    // Green dot has title "Online"
    expect(screen.getByTitle('Online')).toBeInTheDocument();
  });

  it('copy link button works', async () => {
    mockedInvite.mockResolvedValue({
      member: { id: 'm1' },
      inviteLink: 'https://voyza.app/invite/xyz',
    });

    render(<InviteModal {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText('Email address'), {
      target: { value: 'test@test.com' },
    });
    fireEvent.click(screen.getByText('Send Invite'));

    await waitFor(() => {
      expect(screen.getByText('https://voyza.app/invite/xyz')).toBeInTheDocument();
    });

    // Find and click the copy button (sibling of the link text)
    const copyBtn = screen.getByText('https://voyza.app/invite/xyz')
      .parentElement!
      .querySelector('button')!;
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://voyza.app/invite/xyz',
    );
  });

  it('closes when backdrop is clicked', () => {
    const onClose = jest.fn();
    render(<InviteModal {...baseProps} onClose={onClose} />);

    // Click the backdrop (outermost motion.div)
    const backdrop = screen.getByText('Share Canvas').closest('[class*="fixed"]')!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Send button when email is empty', () => {
    render(<InviteModal {...baseProps} />);
    const btn = screen.getByText('Send Invite');
    expect(btn).toBeDisabled();
  });

  it('handles empty members list', () => {
    render(<InviteModal {...baseProps} members={[]} />);
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
  });
});
