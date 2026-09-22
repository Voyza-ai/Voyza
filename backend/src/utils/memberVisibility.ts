/**
 * Who may see a collaborator's email address on a trip.
 *
 * GET /api/canvas/:tripId/members is readable by every member of a trip —
 * including anyone who joined off the share link and was never vetted by the
 * owner. It runs as service-role, so it bypasses RLS and has to re-impose the
 * database's own rule itself. That rule lives in 002_rls_policies.sql:
 * `group_members_owner_all` (the trip owner reads every row on their trips)
 * plus `group_members_self_select` (everyone else reads only their own row).
 * GET /api/users/me/export states the same thing in words — "We explicitly DO
 * NOT include other users' PII (collaborator emails, etc.)".
 *
 * So: the owner sees every address, everybody else sees only their own, and
 * every other row comes back with `email: null`.
 *
 * Editors are deliberately NOT privileged here. Every management capability in
 * canvas.ts — invite, role change, apply-role, share link, transfer ownership,
 * and the `inviteToken` on this very response — is owner-only, so an address
 * belongs on the owner's side of that same line.
 */

/** One row of the enriched member list, as GET /:tripId/members builds it. */
export type EnrichedMember = {
  id: string;
  userId: string | null;
  role: string;
  acceptedAt: string | null;
  createdAt: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  pending: boolean;
  inviteToken: string | null;
};

/** The person asking for the list. */
export type MemberRequester = {
  /** Their role on this trip, from getMemberRole() — null for a non-member. */
  role: string | null;
  userId: string;
  /** Their own address, straight off their token, so their own row stays
   *  populated without an auth.admin lookup. */
  email: string | null;
};

// Labels for a member with no profile name whose address this requester may
// not see. Without them the share dialog renders a nameless row as a blank
// line (it used to fall back to the email).
const MEMBER_LABEL = 'Member';
const PENDING_LABEL = 'Pending invite';

/** True when `requester` may see `member`'s email address. */
export function canSeeMemberEmail(
  requester: MemberRequester,
  member: Pick<EnrichedMember, 'userId'>,
): boolean {
  if (requester.role === 'owner') return true;
  return !!member.userId && member.userId === requester.userId;
}

/**
 * Copy of `member` with the email either kept or replaced by null, plus the
 * `displayName` the UI renders in its place. Never mutates the input.
 */
export function redactMemberIdentity(
  member: EnrichedMember,
  requester: MemberRequester,
): EnrichedMember & { displayName: string } {
  const email = canSeeMemberEmail(requester, member)
    ? member.email ?? (member.userId === requester.userId ? requester.email : null)
    : null;
  return {
    ...member,
    email,
    displayName: member.fullName || email || (member.pending ? PENDING_LABEL : MEMBER_LABEL),
  };
}
