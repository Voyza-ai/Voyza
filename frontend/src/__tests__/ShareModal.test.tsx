import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShareModal from '@/components/canvas/ShareModal';
import {
  getShareLink,
  updateShareLink,
  applyRoleToMembers,
  inviteToCanvas,
  listTripMembers,
  updateMemberRole,
} from '@/lib/api';

const mockedGetShareLink = getShareLink as jest.MockedFunction<typeof getShareLink>;
const mockedUpdateShareLink = updateShareLink as jest.MockedFunction<typeof updateShareLink>;
const mockedApplyRole = applyRoleToMembers as jest.MockedFunction<typeof applyRoleToMembers>;
const mockedInvite = inviteToCanvas as jest.MockedFunction<typeof inviteToCanvas>;
const mockedListMembers = listTripMembers as jest.MockedFunction<typeof listTripMembers>;
const mockedUpdateMemberRole = updateMemberRole as jest.MockedFunction<typeof updateMemberRole>;

const baseProps = {
  tripId: 'trip-1',
  isOpen: true,
  onClose: jest.fn(),
  onToast: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetShareLink.mockResolvedValue({
    mode: 'view',
    token: 'tok-1',
    url: 'https://voyza.test/canvas/trip-1?share=tok-1',
  });
  mockedListMembers.mockResolvedValue({ members: [] });
  Object.assign(navigator, { clipboard: { writeText: jest.fn() } });
});

describe('ShareModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ShareModal {...baseProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('loads and shows the share link with the three access modes', async () => {
    render(<ShareModal {...baseProps} />);
    expect(screen.getByText('Share this trip')).toBeInTheDocument();
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByText('Owner confirms edits')).toBeInTheDocument();
    expect(screen.getByText('Full access')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByDisplayValue('http://localhost/canvas/trip-1?share=tok-1')).toBeInTheDocument();
    });
  });

  it('changes the link mode when a mode card is clicked', async () => {
    mockedUpdateShareLink.mockResolvedValue({
      mode: 'edit',
      token: 'tok-1',
      url: 'https://voyza.test/canvas/trip-1?share=tok-1',
    });
    render(<ShareModal {...baseProps} />);
    await waitFor(() => expect(mockedGetShareLink).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Full access'));
    await waitFor(() => {
      expect(mockedUpdateShareLink).toHaveBeenCalledWith('trip-1', { mode: 'edit' });
    });
  });

  it('copies the link to the clipboard', async () => {
    render(<ShareModal {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByDisplayValue(/share=tok-1/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Copy link'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'http://localhost/canvas/trip-1?share=tok-1',
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('applies the current mode to all existing members after confirm', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mockedApplyRole.mockResolvedValue({ updated: 3, role: 'viewer' });
    render(<ShareModal {...baseProps} />);
    await waitFor(() => expect(mockedGetShareLink).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Apply this access to all current members'));
    await waitFor(() => {
      expect(mockedApplyRole).toHaveBeenCalledWith('trip-1', 'viewer');
    });
  });

  it('sends an email invite and refreshes the member list', async () => {
    mockedInvite.mockResolvedValue({ member: {} as any, inviteLink: 'x' });
    render(<ShareModal {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText('friend@email.com'), {
      target: { value: 'pal@test.com' },
    });
    fireEvent.click(screen.getByLabelText('Send invite'));
    await waitFor(() => {
      expect(mockedInvite).toHaveBeenCalledWith('trip-1', 'pal@test.com', 'editor');
    });
  });

  it('lists members and changes a member role', async () => {
    mockedListMembers.mockResolvedValue({
      members: [
        {
          id: 'm1',
          user_id: 'u2',
          invited_email: 'pal@test.com',
          role: 'viewer',
          accepted_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
        } as any,
      ],
    });
    render(<ShareModal {...baseProps} />);
    expect(await screen.findByText('pal@test.com')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Role for pal@test.com'), {
      target: { value: 'editor' },
    });
    await waitFor(() => {
      expect(mockedUpdateMemberRole).toHaveBeenCalledWith('trip-1', 'm1', 'editor');
    });
  });
});
