import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';

const mockSuggestions = [
  {
    id: 'sug-1',
    type: 'add_city' as const,
    payload: { name: 'Lisbon', estimatedCost: 350, reason: 'Great nightlife' },
    status: 'pending' as const,
    suggested_by: 'user-2',
    created_at: '2026-06-15T10:00:00Z',
  },
  {
    id: 'sug-2',
    type: 'comment' as const,
    payload: { text: 'Can we add a beach day?' },
    status: 'pending' as const,
    suggested_by: 'user-3',
    created_at: '2026-06-15T11:00:00Z',
  },
  {
    id: 'sug-3',
    type: 'add_city' as const,
    payload: { name: 'Porto' },
    status: 'approved' as const,
    suggested_by: 'user-2',
    created_at: '2026-06-14T10:00:00Z',
  },
];

describe('SuggestionsPanel', () => {
  it('renders pending suggestions list', () => {
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="owner"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByText('Pending Suggestions (2)')).toBeInTheDocument();
    expect(screen.getByText('Add Lisbon')).toBeInTheDocument();
    expect(screen.getByText('Comment')).toBeInTheDocument();
  });

  it('owner sees Approve + Reject buttons', () => {
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="owner"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getAllByText('Approve')).toHaveLength(2);
    expect(screen.getAllByText('Reject')).toHaveLength(2);
  });

  it('non-owner does not see Approve/Reject buttons', () => {
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="editor"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject')).not.toBeInTheDocument();
  });

  it('Approve calls onApprove with correct suggestion ID', () => {
    const onApprove = jest.fn();
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="owner"
        onApprove={onApprove}
        onReject={jest.fn()}
      />,
    );
    const approveButtons = screen.getAllByText('Approve');
    fireEvent.click(approveButtons[0]);
    expect(onApprove).toHaveBeenCalledWith('sug-1');
  });

  it('Reject calls onReject with correct suggestion ID', () => {
    const onReject = jest.fn();
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="owner"
        onApprove={jest.fn()}
        onReject={onReject}
      />,
    );
    const rejectButtons = screen.getAllByText('Reject');
    fireEvent.click(rejectButtons[0]);
    expect(onReject).toHaveBeenCalledWith('sug-1');
  });

  it('does not render when no pending suggestions', () => {
    const { container } = render(
      <SuggestionsPanel
        suggestions={[mockSuggestions[2]]} // only approved
        role="owner"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows comment text for comment suggestions', () => {
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="owner"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByText('Can we add a beach day?')).toBeInTheDocument();
  });

  it('handles empty suggestions array', () => {
    const { container } = render(
      <SuggestionsPanel
        suggestions={[]}
        role="owner"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('count badge shows correct number of pending suggestions', () => {
    render(
      <SuggestionsPanel
        suggestions={mockSuggestions}
        role="owner"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByText('Pending Suggestions (2)')).toBeInTheDocument();
  });
});
