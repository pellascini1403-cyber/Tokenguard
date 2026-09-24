/**
 * A single, fully-parsed SSE event — generic, with no knowledge of any AI
 * provider's payload shape. `data` joins multiple `data:` lines with
 * `\n`, per the SSE spec. `event`/`id` are null when the event didn't
 * include that field.
 */
export interface SseEvent {
  event: string | null;
  data: string;
  id: string | null;
}
