import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import OriginClarification from '@/components/results/OriginClarification';
import type { Trip } from '@/lib/types';

/**
 * The line that tells a traveller which reading of an ambiguous origin their
 * trip was priced from.
 *
 * The case it exists for, and the reason this is worth testing rather than
 * eyeballing: someone types "Portland" and gets Oregon, because that is the
 * more prominent reading. If they meant Maine, every flight and every price on
 * the trip is for the wrong city and nothing else on screen says a choice was
 * even made.
 */

const PORTLAND: NonNullable<Trip['originClarification']> = {
  input: 'Portland',
  reason: 'near-tie',
  candidates: [
    {
      placeId: 'gn:5746545',
      label: 'Portland, Oregon, United States',
      airports: ['PDX', 'SLE'],
    },
    {
      placeId: 'gn:4975802',
      label: 'Portland, Maine, United States',
      airports: ['PWM', 'PSM', 'AUG'],
      distanceKm: 4_020,
    },
    {
      placeId: 'gn:4723314',
      label: 'Portland, Texas, United States',
      airports: ['CRP', 'VCT'],
    },
  ],
};

describe('OriginClarification', () => {
  it('names the reading the trip was priced from, and the airport', () => {
    render(<OriginClarification clarification={PORTLAND} pricedFrom={['PDX', 'SLE']} />);
    expect(screen.getByText('Portland, Oregon, United States')).toBeInTheDocument();
    expect(screen.getByText(/\(PDX\)/)).toBeInTheDocument();
  });

  it('quotes what the traveller actually typed', () => {
    // Without this the line reads as a system opinion rather than an answer
    // to something they did.
    render(<OriginClarification clarification={PORTLAND} pricedFrom={['PDX']} />);
    expect(screen.getByText(/You typed/)).toHaveTextContent('Portland');
    expect(screen.getByText(/matches 3 places/)).toBeInTheDocument();
  });

  it('keeps the alternatives out of the way until asked', () => {
    render(<OriginClarification clarification={PORTLAND} pricedFrom={['PDX']} />);
    expect(screen.queryByText('Portland, Maine, United States')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /see the others/i }));
    expect(screen.getByText('Portland, Maine, United States')).toBeInTheDocument();
    expect(screen.getByText('Portland, Texas, United States')).toBeInTheDocument();
    // The one already in use is not offered again.
    expect(screen.queryAllByText('Portland, Oregon, United States')).toHaveLength(1);
  });

  it('shows each alternative’s airports and distance', () => {
    // Distance is the single most useful distinguisher between two places
    // with one name, and every candidate carries it.
    render(<OriginClarification clarification={PORTLAND} pricedFrom={['PDX']} />);
    fireEvent.click(screen.getByRole('button', { name: /see the others/i }));
    expect(screen.getByText('PWM · PSM · AUG')).toBeInTheDocument();
    expect(screen.getByText('4,020 km away')).toBeInTheDocument();
  });

  it('hands back the chosen reading, with its airports', () => {
    const onChoose = jest.fn();
    render(
      <OriginClarification clarification={PORTLAND} pricedFrom={['PDX']} onChoose={onChoose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /see the others/i }));
    fireEvent.click(screen.getByText('Portland, Maine, United States'));

    expect(onChoose).toHaveBeenCalledWith({
      placeId: 'gn:4975802',
      label: 'Portland, Maine, United States',
      airports: ['PWM', 'PSM', 'AUG'],
    });
  });

  it('says "the other" when there is exactly one', () => {
    const melbourne: NonNullable<Trip['originClarification']> = {
      input: 'Melbourne',
      reason: 'multi-country',
      candidates: [
        { placeId: 'a', label: 'Melbourne, Victoria, Australia', airports: ['MEL'] },
        { placeId: 'b', label: 'Melbourne, Florida, United States', airports: ['MCO'] },
      ],
    };
    render(<OriginClarification clarification={melbourne} pricedFrom={['MEL']} />);
    expect(screen.getByRole('button', { name: /see the other$/i })).toBeInTheDocument();
  });

  it('renders nothing when there is no real choice to offer', () => {
    // Defensive: a single candidate is not a clarification, and a line saying
    // "we picked the only option" is noise.
    const { container } = render(
      <OriginClarification
        clarification={{ ...PORTLAND, candidates: [PORTLAND.candidates[0]] }}
        pricedFrom={['PDX']}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the alternatives but does not offer them when nothing can act', () => {
    // No `onChoose`: the list is still worth seeing, and a button that looks
    // live but does nothing is worse than one that is plainly inert.
    render(<OriginClarification clarification={PORTLAND} pricedFrom={['PDX']} />);
    fireEvent.click(screen.getByRole('button', { name: /see the others/i }));
    const maine = screen.getByText('Portland, Maine, United States').closest('button');
    expect(maine).toBeDisabled();
  });

  it('keeps every alternative in ONE row, however many there are', () => {
    // `Springfield` resolves to eight readings. Wrapped, that was seven cards
    // over two rows, which pushed the city cards down the page — the banner's
    // height depended on how ambiguous the name happened to be. One scrolled
    // row makes it constant.
    const springfield: NonNullable<Trip['originClarification']> = {
      input: 'Springfield',
      reason: 'near-tie',
      candidates: Array.from({ length: 8 }, (_, i) => ({
        placeId: `gn:${i}`,
        label: `Springfield, State ${i}, United States`,
        airports: ['AAA', 'BBB'],
        distanceKm: 100 * (i + 1),
      })),
    };
    render(<OriginClarification clarification={springfield} pricedFrom={['AAA']} />);
    fireEvent.click(screen.getByRole('button', { name: /see the others/i }));

    // All seven alternatives are present — scrolling hides none of them.
    for (let i = 1; i < 8; i += 1) {
      expect(screen.getByText(`Springfield, State ${i}, United States`)).toBeInTheDocument();
    }

    // And the list scrolls rather than wrapping. Asserted on the container
    // because jsdom has no layout: without this, a future change back to
    // flex-wrap would pass every other test in this file.
    const list = screen.getByText('Springfield, State 1, United States').closest('ul');
    expect(list).toHaveClass('overflow-x-auto');
    expect(list).not.toHaveClass('flex-wrap');
  });

  it('prefers the airports the trip was really priced from', () => {
    // `pricedFrom` comes off the trip, the candidate's list from the
    // resolver. They can differ when the caller supplied its own, and the
    // line must name what was actually used.
    render(<OriginClarification clarification={PORTLAND} pricedFrom={['HIO']} />);
    expect(screen.getByText(/\(HIO\)/)).toBeInTheDocument();
  });
});
