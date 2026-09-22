import { canSeeMemberEmail, redactMemberIdentity, EnrichedMember } from '../utils/memberVisibility';

/**
 * The member list is readable by every member of a trip — including a viewer
 * who joined off the share link and was never vetted by the owner. It used to
 * hand that viewer every collaborator's real email address, which is the exact
 * PII GET /api/users/me/export refuses to include and the exact split
 * group_members' RLS policies draw (owner reads every row, everyone else reads
 * only their own).
 */
const member = (over: Partial<EnrichedMember> = {}): EnrichedMember => ({
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

const owner = { role: 'owner', userId: 'u1', email: 'owner@test.com' };
const linkViewer = { role: 'viewer', userId: 'u9', email: 'viewer@test.com' };
const editor = { role: 'editor', userId: 'u7', email: 'editor@test.com' };

describe('member email visibility', () => {
  it('gives the owner every address', () => {
    expect(redactMemberIdentity(member(), owner).email).toBe('pal@test.com');
    expect(canSeeMemberEmail(owner, member())).toBe(true);
  });

  it('never gives a link-joined viewer another person’s address', () => {
    const seen = redactMemberIdentity(member(), linkViewer);
    expect(seen.email).toBeNull();
    expect(canSeeMemberEmail(linkViewer, member())).toBe(false);
  });

  it('does not privilege editors — they manage nothing else on this trip', () => {
    expect(redactMemberIdentity(member(), editor).email).toBeNull();
  });

  it('still shows a member their OWN address', () => {
    const self = { role: 'viewer', userId: 'u2', email: 'pal@test.com' };
    // The route skips the auth.admin lookup for non-owners, so the row
    // arrives with email null and the token's own address fills it in.
    expect(redactMemberIdentity(member({ email: null }), self).email).toBe('pal@test.com');
  });

  it('keeps a redacted row renderable instead of blanking the member list', () => {
    // Name present: the UI shows the name, as it already does.
    expect(redactMemberIdentity(member(), linkViewer).displayName).toBe('Pal Smith');
    // No profile name and no address to fall back on — a neutral label,
    // not an empty line.
    expect(redactMemberIdentity(member({ fullName: null }), linkViewer).displayName).toBe('Member');
    expect(
      redactMemberIdentity(
        member({ userId: null, fullName: null, email: 'new@test.com', pending: true }),
        linkViewer,
      ).displayName,
    ).toBe('Pending invite');
  });

  it('redacts a pending invite the owner typed in, for everyone but the owner', () => {
    const invite = member({ userId: null, fullName: null, email: 'new@test.com', pending: true });
    expect(redactMemberIdentity(invite, owner).email).toBe('new@test.com');
    expect(redactMemberIdentity(invite, linkViewer).email).toBeNull();
  });

  it('leaves the row it was handed untouched', () => {
    const row = member();
    redactMemberIdentity(row, linkViewer);
    expect(row.email).toBe('pal@test.com');
  });

  it('treats a non-member (null role) as unprivileged', () => {
    expect(canSeeMemberEmail({ role: null, userId: 'u9', email: null }, member())).toBe(false);
  });
});
