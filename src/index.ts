import { createApp } from "./api";
import { runScheduled } from "./scheduler";
import type { Env } from "./types";

const app = createApp();

export const fetch = app.fetch;

export const scheduled = (
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> => runScheduled(env, controller.scheduledTime);

export default { fetch, scheduled };
