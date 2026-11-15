import './mocks';
import { mockSearchParams, mockReplace } from './mocks';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import CanvasRedirect from '@/app/canvas/[tripId]/page';

/**
 * The canvas page is gone (the results page is the canvas now), but links
 * already sent — invite emails, notifications, share links — still say
 * /canvas/<id>?share=<token>. They land on the trip, share token and all.
 */
describe('/canvas/<id>', () => {
  afterEach(() => mockSearchParams.delete('share'));

  it('opens the trip on the results page', async () => {
    render(<CanvasRedirect />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/results?tripId=trip-test-123'));
  });

  it('keeps a share token, so the join still happens', async () => {
    mockSearchParams.set('share', 'tok-1');
    render(<CanvasRedirect />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/results?tripId=trip-test-123&share=tok-1'));
  });
});
