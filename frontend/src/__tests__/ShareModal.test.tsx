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
  transferOwnership,
} from '@/lib/api';

const mockedGetShareLink = getShareLink as jest.MockedFunction<typeof getShareLink>;
const mockedUpdateShareLink = updateShareLink as jest.MockedFunction<typeof updateShareLink>;
const mockedApplyRole = applyRoleToMembers as jest.MockedFunction<typeof applyRoleToMembers>;
const mockedInvite = inviteToCanvas as jest.MockedFunction<typeof inviteToCanvas>;
const mockedListMembers = listTripMembers as jest.MockedFunction<typeof listTripMembers>;
const mockedUpdateMemberRole = updateMemberRole as jest.MockedFunction<typeof updateMemberRole>;
const mockedTransfer = transferOwnership as jest.MockedFunction<typeof transferOwnership>;

const onRoleChanged = jest.fn();
const baseProps = {
  tripId: 'trip-1',
  isOpen: true,
  onClose: jest.fn(),
  onToast: jest.fn(),
  onRoleChanged,
};

// The real /members contract: enriched, camelCase. Round 1 mocked
// snake_case, so the tests passed while prod silently read undefined
// (names → "Member", no crown, role-change never broadcast).
const member = (over: Partial<any> = {}) => ({
  id: 'm1',
  userId: 'u2',
  role: 'viewer',
  acceptedAt: '2026-07-01T00:00:00Z',
  createdAt: '2026-07-01T00:00:00Z',
  email: 'pal@test.com',
  fullName: 'Pal Smith',
  avatarUrl: null,
  pending: false,
  inviteToken: null,
  ...over,
});

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

  it("shows the member's real NAME (not 'Member') and their email", async () => {
    mockedListMembers.mockResolvedValue({ members: [member()] as any });
    render(<ShareModal {...baseProps} />);
    // Regression: the enriched name must render, not the "Member" fallback.
    expect(await screen.findByText('Pal Smith')).toBeInTheDocument();
    expect(screen.getByText('pal@test.com')).toBeInTheDocument();
    expect(screen.queryByText('Member')).not.toBeInTheDocument();
  });

  it('changes a member role AND broadcasts it to that user', async () => {
    mockedListMembers.mockResolvedValue({ members: [member()] as any });
    render(<ShareModal {...baseProps} />);
    await screen.findByText('Pal Smith');

    fireEvent.change(screen.getByLabelText('Role for pal@test.com'), {
      target: { value: 'editor' },
    });
    await waitFor(() => {
      expect(mockedUpdateMemberRole).toHaveBeenCalledWith('trip-1', 'm1', 'editor');
    });
    // The live-notify event MUST fire with the real userId (round 1 read
    // undefined here, so the friend had to refresh).
    expect(onRoleChanged).toHaveBeenCalledWith('u2', 'editor');
  });

  it('offers the crown (transfer) only for accepted members with a user', async () => {
    mockedListMembers.mockResolvedValue({
      members: [
        member({ id: 'accepted', pending: false, userId: 'u2' }),
        member({ id: 'pending', pending: true, userId: null, email: 'new@test.com', fullName: null }),
      ] as any,
    });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mockedTransfer.mockResolvedValue({ success: true, newOwnerUserId: 'u2' } as any);

    render(<ShareModal {...baseProps} />);
    await screen.findByText('Pal Smith');
    // Accepted member has the crown; pending invite does not.
    expect(screen.getByLabelText('Make pal@test.com the owner')).toBeInTheDocument();
    expect(screen.queryByLabelText('Make new@test.com the owner')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Make pal@test.com the owner'));
    await waitFor(() => {
      expect(mockedTransfer).toHaveBeenCalledWith('trip-1', 'accepted');
    });
    expect(onRoleChanged).toHaveBeenCalledWith('u2', 'owner');
  });

  it('shows a Copy-link button for a pending personal invite (owner only)', async () => {
    mockedListMembers.mockResolvedValue({
      members: [
        member({ id: 'inv', pending: true, userId: null, fullName: null, email: 'new@test.com', inviteToken: 'tok-xyz' }),
      ] as any,
    });
    render(<ShareModal {...baseProps} />);
    const copyBtn = await screen.findByLabelText('Copy invite link for new@test.com');
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('share=tok-xyz'),
    );
  });
});
