import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SuggestedCitiesPanel from '@/components/canvas/SuggestedCitiesPanel';
import { suggestDestinations } from '@/lib/api';

const baseProps = {
  tripId: 'trip-1',
  currentCities: ['Paris', 'Nice'],
  role: 'owner',
  onAddCity: jest.fn(),
  onSuggestCity: jest.fn(),
};

describe('SuggestedCitiesPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (suggestDestinations as jest.Mock).mockResolvedValue([]);
  });

  it('starts closed, showing only the labeled pull-out tab', () => {
    render(<SuggestedCitiesPanel {...baseProps} />);
    expect(screen.getByLabelText('Open suggested cities')).toBeInTheDocument();
    // Panel content is not mounted while closed
    expect(screen.queryByLabelText('Close suggested cities')).not.toBeInTheDocument();
    expect(screen.queryByText('No suggestions yet')).not.toBeInTheDocument();
  });

  it('opens from the tab and closes from the ✕ in the header', async () => {
    render(<SuggestedCitiesPanel {...baseProps} />);

    fireEvent.click(screen.getByLabelText('Open suggested cities'));
    expect(await screen.findByLabelText('Close suggested cities')).toBeInTheDocument();
    // Tab hides while the panel is open
    expect(screen.queryByLabelText('Open suggested cities')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close suggested cities'));
    expect(screen.getByLabelText('Open suggested cities')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close suggested cities')).not.toBeInTheDocument();
  });

  it('fetches on first open and lets editors add a suggestion to the canvas', async () => {
    (suggestDestinations as jest.Mock).mockResolvedValue([
      { name: 'Lisbon', estimatedCost: 350, reason: 'Cheap, sunny, great food' },
    ]);
    render(<SuggestedCitiesPanel {...baseProps} />);

    fireEvent.click(screen.getByLabelText('Open suggested cities'));
    expect(await screen.findByText('Lisbon')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add to canvas'));
    expect(baseProps.onAddCity).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Lisbon' }),
    );
  });

  it('shows Suggest (not Add) for suggester role', async () => {
    (suggestDestinations as jest.Mock).mockResolvedValue([
      { name: 'Porto', estimatedCost: 280, reason: 'River views' },
    ]);
    render(<SuggestedCitiesPanel {...baseProps} role="suggester" />);

    fireEvent.click(screen.getByLabelText('Open suggested cities'));
    expect(await screen.findByText('Porto')).toBeInTheDocument();
    expect(screen.getByText('Suggest')).toBeInTheDocument();
    expect(screen.queryByText('Add to canvas')).not.toBeInTheDocument();
  });
});
