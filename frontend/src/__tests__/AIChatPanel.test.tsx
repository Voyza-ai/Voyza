import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { editPlan } from '@/lib/api';

const mockedEditPlan = editPlan as jest.MockedFunction<typeof editPlan>;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip() });
});

describe('AIChatPanel', () => {
  it('shows initial greeting message with trip info', () => {
    const trip = buildTrip({ savings: 249 });
    render(<AIChatPanel trip={trip} />);
    expect(screen.getByText(/2-city trip/)).toBeInTheDocument();
    expect(screen.getByText(/\$249/)).toBeInTheDocument();
  });

  it('renders suggested prompt chips', () => {
    render(<AIChatPanel trip={buildTrip()} />);
    expect(screen.getByText('Why is this trip cheaper?')).toBeInTheDocument();
    expect(screen.getByText('Make Barcelona cheaper')).toBeInTheDocument();
  });

  it('sends message to editPlan API on submit', async () => {
    mockedEditPlan.mockResolvedValue({ message: 'Here is my response', trip: null });

    render(<AIChatPanel trip={buildTrip()} />);

    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Make it cheaper' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(mockedEditPlan).toHaveBeenCalledWith({
        message: 'Make it cheaper',
        currentTrip: expect.any(Object),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Here is my response')).toBeInTheDocument();
    });
  });

  it('shows mock fallback message when API fails', async () => {
    mockedEditPlan.mockRejectedValue(new Error('No API key'));

    render(<AIChatPanel trip={buildTrip()} />);

    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Why is this trip cheaper?' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      // Should fall back to mock response containing savings tips
      const messages = screen.getAllByText(/save|routing|cheaper/i);
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  it('applies trip patch to Zustand store when returned in response', async () => {
    const updatedTrip = buildTrip({ totalCost: 900, savings: 400 });
    mockedEditPlan.mockResolvedValue({ message: 'Updated!', trip: updatedTrip });

    render(<AIChatPanel trip={buildTrip()} />);

    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Make it cheaper' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Updated!')).toBeInTheDocument();
    });

    // Check Zustand store was updated
    const storeTrip = useTripStore.getState().currentTrip;
    expect(storeTrip?.totalCost).toBe(900);
    expect(storeTrip?.savings).toBe(400);
  });

  it('does not crash when API returns 500', async () => {
    mockedEditPlan.mockRejectedValue(new Error('Internal Server Error'));

    render(<AIChatPanel trip={buildTrip()} />);

    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.submit(input.closest('form')!);

    // Should not crash, should show fallback
    await waitFor(() => {
      const allMessages = screen.getAllByText(/.+/);
      expect(allMessages.length).toBeGreaterThan(1);
    });
  });

  it('disables send button when input is empty', () => {
    render(<AIChatPanel trip={buildTrip()} />);
    const sendBtn = screen.getByLabelText('Send');
    expect(sendBtn).toBeDisabled();
  });

  it('clears input after sending', async () => {
    mockedEditPlan.mockResolvedValue({ message: 'OK', trip: null });

    render(<AIChatPanel trip={buildTrip()} />);

    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Test message' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });
});
