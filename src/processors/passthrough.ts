import type { ErrorEvent, ProcessedEvent, Processor } from "../types.ts";

export class PassthroughProcessor implements Processor {
  readonly name = "passthrough";

  async process(events: ErrorEvent[]): Promise<ProcessedEvent[]> {
    return events.map((event) => ({ ...event }));
  }
}
