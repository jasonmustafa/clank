import type { JobRecord } from "../jobs/jobStore.js";

export interface ThreadRouteInput {
  channelId: string;
  parentChannelId?: string | null;
  isThread: boolean;
  userId: string;
}

export type ThreadRoute =
  | { type: "existing-job"; jobId: string }
  | { type: "latest-channel-job"; jobId: string }
  | { type: "new-job" };

export interface ThreadRouteStore {
  findByThread(threadId: string): JobRecord | undefined;
  findLatestForChannel(channelId: string, ownerUserId: string): JobRecord | undefined;
}

export function routeThread(input: ThreadRouteInput, store: ThreadRouteStore): ThreadRoute {
  if (input.isThread) {
    const record = store.findByThread(input.channelId);
    if (record) return { type: "existing-job", jobId: record.id };
    return { type: "new-job" };
  }

  const latest = store.findLatestForChannel(input.channelId, input.userId);
  if (latest) return { type: "latest-channel-job", jobId: latest.id };
  return { type: "new-job" };
}
