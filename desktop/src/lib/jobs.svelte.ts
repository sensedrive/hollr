// The background job whose detail is open (a click on a job in the chat or the composer); AgentView shows it.
import { gate } from "./api";

export const jobOpen = $state<{ id: string | null }>({ id: null });
export const openJob = (id: string) => (jobOpen.id = id);

export interface JobDetail {
  id: string;
  tool?: string;
  intent?: string;
  command?: string;
  startedAt?: number;
  status: "running" | "done" | "unknown";
  output?: string;
  finishedAt?: number;
}

/** older servers answer "not_allowed" */
export const jobDetail = (server: string, pane: string, id: string) => gate<JobDetail>(server, `job ${pane} ${id}`);
