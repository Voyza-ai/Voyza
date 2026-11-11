import type { OutboundText, TextProvider } from '../types';

/** In-memory provider for tests and the local CLI simulator. Sends nothing. */
export class SimulatorProvider implements TextProvider {
  readonly name = 'simulator' as const;
  readonly sent: OutboundText[] = [];
  constructor(private onSend?: (m: OutboundText) => void) {}
  async send(msg: OutboundText) {
    this.sent.push(msg);
    this.onSend?.(msg);
  }
}
