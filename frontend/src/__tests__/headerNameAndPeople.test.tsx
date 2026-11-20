import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { shortRouteTitle } from '@/components/results/ResultsHeader';
import TripNameEditor from '@/components/shared/TripNameEditor';
import CollaboratorAvatars from '@/components/results/CollaboratorAvatars';
import { listTripMembers } from '@/lib/api';

/**
 * The results header: a long route name shortened to "+N more", and the
 * collaborators' faces — three, then "+N" with everyone listed on hover.
 */

describe('shortRouteTitle', () => {
  it('keeps up to three cities as they are', () => {
    expect(shortRouteTitle('London → Paris')).toBe('London → Paris');
    expect(shortRouteTitle('Lisbon → Porto → Madrid')).toBe('Lisbon → Porto → Madrid');
  });
  it('past three: the first three, then "+N more"', () => {
    expect(shortRouteTitle('Lisbon → Porto → Madrid → Barcelona')).toBe('Lisbon → Porto → Madrid + 1 more');
    expect(shortRouteTitle('Lisbon → Porto → Madrid → Barcelona → Nice → Milan → Venice')).toBe(
      'Lisbon → Porto → Madrid + 4 more',
    );
  });
  it('a name someone typed is shown as typed', () => {
    expect(shortRouteTitle('Honeymoon in Italy')).toBe('Honeymoon in Italy');
    expect(shortRouteTitle('')).toBe('');
  });
});

describe('TripNameEditor with a shortened name', () => {
  const full = 'Lisbon → Porto → Madrid → Barcelona → Nice';
  it('shows the short form, the full route on hover, and edits the full name', () => {
    render(<TripNameEditor value={full} displayValue={shortRouteTitle(full)} canRename onRename={jest.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('Lisbon → Porto → Madrid + 2 more');
    expect(btn.getAttribute('title')).toBe(`${full} — click to rename`);
    fireEvent.click(btn);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(full);
  });
  it('a short name keeps its usual hint', () => {
    render(<TripNameEditor value="London → Paris" displayValue="London → Paris" canRename onRename={jest.fn()} />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Rename this trip');
  });
});

describe('CollaboratorAvatars', () => {
  const presence = [
    { id: 'u1', name: 'Avery Lee' },
    { id: 'u2', name: 'Sam Ortiz' },
  ] as any;
  const members = ['Avery Lee', 'Sam Ortiz', 'Jordan Park', 'Riley Chen', 'Kai Moreno'].map((n, i) => ({
    userId: `u${i + 1}`,
    fullName: n,
    role: i === 0 ? 'owner' : i === 1 ? 'editor' : 'viewer',
    pending: false,
    avatarUrl: null,
  }));

  it('shows three faces and "+N"; hovering lists everyone, online first, with roles', async () => {
    (listTripMembers as jest.Mock).mockResolvedValueOnce({ members });
    render(<CollaboratorAvatars tripId="t1" presence={presence} selfId="u1" refreshKey={0} />);
    const more = await screen.findByTestId('collaborators-more');
    expect(more).toHaveTextContent('+2');
    expect(screen.queryByTestId('collaborators-list')).toBeNull();
    fireEvent.mouseEnter(more);
    const list = screen.getByTestId('collaborators-list');
    const rows = Array.from(list.querySelectorAll('[role=listitem]')).map((r) => r.textContent);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('Avery Lee (you)');
    expect(rows[0]).toContain('owner · here now');
    expect(rows[1]).toContain('Sam Ortiz');
    expect(rows[1]).toContain('editor · here now');
    expect(rows.slice(2).every((r) => !r!.includes('here now'))).toBe(true);
    fireEvent.mouseLeave(list.parentElement!);
    expect(screen.queryByTestId('collaborators-list')).toBeNull();
  });

  it('three people or fewer: no "+N"', async () => {
    (listTripMembers as jest.Mock).mockResolvedValueOnce({ members: members.slice(0, 3) });
    render(<CollaboratorAvatars tripId="t2" presence={presence} selfId="u1" refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('collaborator-avatars')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('3 people on this trip')).toBeInTheDocument());
    expect(screen.queryByTestId('collaborators-more')).toBeNull();
  });
});
