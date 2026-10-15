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
  displayName: 'Pal Smith',
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
    // The raw URL is no longer displayed — just a Copy link button.
    await waitFor(() => expect(screen.getByText('Copy link')).toBeEnabled());
    expect(screen.queryByDisplayValue(/share=tok-1/)).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('Copy link')).toBeEnabled());
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

  it('blocks inviting your own email (any casing) without calling the API', async () => {
    render(<ShareModal {...baseProps} />);
    // Logged-in user in the shared auth mock is test@test.com.
    fireEvent.change(screen.getByPlaceholderText('friend@email.com'), {
      target: { value: '  TEST@test.com ' },
    });
    fireEvent.click(screen.getByLabelText('Send invite'));
    expect(screen.getByRole('alert')).toHaveTextContent("You can't invite yourself");
    expect(mockedInvite).not.toHaveBeenCalled();

    // Editing the email clears the error.
    fireEvent.change(screen.getByPlaceholderText('friend@email.com'), {
      target: { value: 'pal@test.com' },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels the section "Friend invites" with no send-it-yourself copy', () => {
    render(<ShareModal {...baseProps} />);
    expect(screen.getByText('Friend invites')).toBeInTheDocument();
    expect(screen.queryByText(/Personal invites/)).not.toBeInTheDocument();
    expect(screen.queryByText(/send it yourself/)).not.toBeInTheDocument();
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
        member({ id: 'pending', pending: true, userId: null, email: 'new@test.com', fullName: null, displayName: 'new@test.com' }),
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
        member({ id: 'inv', pending: true, userId: null, fullName: null, email: 'new@test.com', displayName: 'new@test.com', inviteToken: 'tok-xyz' }),
      ] as any,
    });
    render(<ShareModal {...baseProps} />);
    const copyBtn = await screen.findByLabelText('Copy invite link for new@test.com');
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('share=tok-xyz'),
    );
  });

  it('renders a row whose email was redacted by its label, never as a blank line', async () => {
    // What a NON-owner gets from /members: every other person's email is
    // null, displayName always present. The list must stay readable.
    mockedListMembers.mockResolvedValue({
      members: [
        member({ id: 'named', email: null, displayName: 'Pal Smith' }),
        member({ id: 'nameless', userId: 'u3', email: null, fullName: null, displayName: 'Member' }),
      ] as any,
    });
    render(<ShareModal {...baseProps} />);
    expect(await screen.findByText('Pal Smith')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
    // No address anywhere in the DOM for a redacted row.
    expect(screen.queryByText('pal@test.com')).not.toBeInTheDocument();
  });

  it('marks your own row with (you) so same-named accounts are distinguishable', async () => {
    // u1 is the signed-in user in the shared auth mock.
    mockedListMembers.mockResolvedValue({
      members: [member({ id: 'me', userId: 'u1' }), member({ id: 'other', userId: 'u9' })] as any,
    });
    render(<ShareModal {...baseProps} />);
    expect(await screen.findByText('(you)')).toBeInTheDocument();
    expect(screen.getAllByText('(you)')).toHaveLength(1);
  });

  describe('as an editor (Google Docs-style sharing)', () => {
    const editorProps = { ...baseProps, role: 'editor' };

    it('can copy the link and invite friends', async () => {
      mockedInvite.mockResolvedValue({ member: {} as any, inviteLink: 'x' });
      render(<ShareModal {...editorProps} />);
      await waitFor(() => expect(screen.getByText('Copy link')).toBeEnabled());
      fireEvent.click(screen.getByText('Copy link'));
      expect(navigator.clipboard.writeText).toHaveBeenCalled();

      fireEvent.change(screen.getByPlaceholderText('friend@email.com'), {
        target: { value: 'pal@test.com' },
      });
      fireEvent.click(screen.getByLabelText('Send invite'));
      await waitFor(() =>
        expect(mockedInvite).toHaveBeenCalledWith('trip-1', 'pal@test.com', 'editor'),
      );
    });

    it('cannot change link mode, reset the link, or manage members', async () => {
      mockedListMembers.mockResolvedValue({ members: [member()] as any });
      render(<ShareModal {...editorProps} />);
      expect(await screen.findByText('Pal Smith')).toBeInTheDocument();

      // Read-only summary instead of the mode cards.
      expect(screen.getByText(/Only the owner can change link access or manage people/)).toBeInTheDocument();
      expect(screen.getByText('editor')).toBeInTheDocument(); // "You're an editor"
      // Proper sentence, not "can full access" (default mode in mocks is view).
      expect(screen.getByText('view the trip')).toBeInTheDocument();
      expect(screen.queryByText(/can full access/)).not.toBeInTheDocument();
      expect(screen.queryByText('Full access')).not.toBeInTheDocument();
      expect(screen.queryByText(/Reset link/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Apply this access/)).not.toBeInTheDocument();
      // No role select, transfer, or remove controls on member rows.
      expect(screen.queryByLabelText(/Role for/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/the owner$/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^Remove /)).not.toBeInTheDocument();
    });
  });
});
