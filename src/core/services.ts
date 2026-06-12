import { EventBus } from './events.js';
import { IOChannel } from '../io/channel.js';

// ── Services — the two capabilities threaded through the whole harness ───────
// bus: emit events (rendered by the IO channel + written to the run trace)
// io:  ask the user a question and wait for the answer
// One object instead of two parameters everywhere.
export interface Services {
  bus: EventBus;
  io: IOChannel;
}
