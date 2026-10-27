/** Shared types for the standalone corehost layer. */
export type HostSnapshot = {
  running: boolean;
  pid: number | null;
  pending_requests: number;
  exe: string | null;
  exe_error: string | null;
  started_at: number | null;
  restarts: number;
};
