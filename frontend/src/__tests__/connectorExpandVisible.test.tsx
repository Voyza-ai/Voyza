/**
 * D-14: the expanded transport card opened partly hidden behind the AI panel.
 *
 * The flowchart is a horizontal scroller that ends where the AI panel
 * begins; a pill near its right edge widens to a 540px card in place, and
 * the part past the edge was cut off (r1-transport-detail-1.png). Harness
 * 2026-10-30 (NYC → Paris, London, Zurich): 3 of 4 legs opened past the
 * scroller's edge — at 1440×900 a card spanned x 840–1376 against an edge at
 * 1040; at 1280×800, 732–1268 against 880.
 *
 * Once the card has widened, it is scrolled into the flowchart's view
 * (`nearest`: a card already fully visible does not move). jsdom has no
 * layout, so this pins the call; the harness measures the result.
 */
import './mocks';
import React from 'react';
import { act, render } from '@testing-library/react';
import Connector from '@/components/results/Connector';
import { buildTrip, mockTransportFlight } from './fixtures';
import { useTripStore } from '@/store/tripStore';

const scrollIntoView = jest.fn();
beforeAll(() => {
  (Element.prototype as any).scrollIntoView = scrollIntoView;
});
beforeEach(() => {
  jest.useFakeTimers();
  scrollIntoView.mockClear();
  useTripStore.setState({ currentTrip: buildTrip() });
});
afterEach(() => jest.useRealTimers());

const props = { index: 0, cityIndex: 0, onToggle: jest.fn() };

describe('expanded transport card', () => {
  it('is brought fully into view once it has widened', () => {
    const { rerender } = render(<Connector transport={mockTransportFlight} {...props} isExpanded={false} />);
    rerender(<Connector transport={mockTransportFlight} {...props} isExpanded />);
    // Not mid-animation: the width transition is 300ms.
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(400));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  });

  it('does not scroll anything for a collapsed pill', () => {
    render(<Connector transport={mockTransportFlight} {...props} isExpanded={false} />);
    act(() => jest.advanceTimersByTime(1000));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('a card closed before it finished opening does not scroll', () => {
    const { rerender } = render(<Connector transport={mockTransportFlight} {...props} isExpanded />);
    act(() => jest.advanceTimersByTime(100));
    rerender(<Connector transport={mockTransportFlight} {...props} isExpanded={false} />);
    act(() => jest.advanceTimersByTime(1000));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
