import { expect, test } from "bun:test";
import { CollectingSink } from "../../src/engine/sink";

test("CollectingSink records pushes in order and reports its session id", () => {
  const sink = new CollectingSink("sess-1");
  sink.push({ type: "push_message", text: "satu", meta: {} });
  sink.push({ type: "push_message", text: "dua", meta: {} });

  expect(sink.sent.map((m) => m.text)).toEqual(["satu", "dua"]);
  expect(sink.sessionId()).toBe("sess-1");
});

// undefined, never the string "undefined": the poller spreads this value into
// push meta only when it is defined, and cc-plugin's forwarder coerces whatever
// arrives with String(). A sink that reported "undefined" would put that word in
// front of the AI as if it were a real session id.
test("CollectingSink without a session id reports undefined, not the string", () => {
  const sink = new CollectingSink();
  expect(sink.sessionId()).toBeUndefined();
});
