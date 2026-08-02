/**
 * One outgoing push, exactly as the MCP notification forwarder consumes it.
 *
 * Moved here from socket/protocol.ts: the shape survived the socket's removal
 * because it was never about the socket -- it is the contract between the poller
 * and whoever hands messages to the AI.
 */
export type PushMessage = { type: "push_message"; text: string; meta: Record<string, string> };

/**
 * Where a stored message goes next.
 *
 * Replaces ConnectionRegistry, which existed to fan one message out to N socket
 * connections per bot. A single process has exactly one destination, so the
 * fan-out -- and with it the "was anyone listening?" boolean that drove the
 * offline queue -- has nothing left to decide.
 */
export interface MessageSink {
  push(msg: PushMessage): void;
  /**
   * The Claude Code session this process belongs to, or undefined when the host
   * did not export one. A method rather than a field so an implementation can
   * resolve it lazily; the poller reads it once per message so the stored row
   * and the pushed meta can never disagree.
   */
  sessionId(): string | undefined;
}

/** Test double. Keeps every push so assertions can read them back in order. */
export class CollectingSink implements MessageSink {
  readonly sent: PushMessage[] = [];
  constructor(private readonly session?: string) {}
  push(msg: PushMessage): void {
    this.sent.push(msg);
  }
  sessionId(): string | undefined {
    return this.session;
  }
}
