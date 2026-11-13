import { Plugin } from "@opencode/plugin";
import { setupLoopGuard } from "./loop-guard";
import { setupCompaction } from "./compaction";
import { setupInsights } from "./insights";

export default Plugin.define({
  id: "hffmnnj.frontier-harness",
  async setup(ctx) {
    const cleanups: Plugin.Cleanup[] = [];
    try {
      for (const setup of [setupLoopGuard, setupCompaction, setupInsights]) {
        cleanups.push(await setup(ctx));
      }
    } catch (error) {
      for (const cleanup of cleanups.reverse()) await cleanup();
      throw error;
    }
    return async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    };
  },
});
