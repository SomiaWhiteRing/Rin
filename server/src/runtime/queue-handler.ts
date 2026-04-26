import { drizzle } from "drizzle-orm/d1";
import { CacheImpl } from "../utils/cache";
import { isQueueTask, FEED_AI_SUMMARY_TASK, IMAGE_COMPRESSION_TASK } from "../queue";
import { processFeedAISummaryTask } from "../services/feed-ai-summary";
import { clearFeedCache } from "../services/feed";
import { processImageCompressionTask } from "../services/images";

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
) {
  const schema = await import("../db/schema");
  const db = drizzle(env.DB, { schema });
  const serverConfig = new CacheImpl(db, env, "server.config", "database");
  const clientConfig = new CacheImpl(db, env, "client.config", "database");
  const cache = new CacheImpl(db, env, "cache", undefined, clientConfig);

  for (const message of batch.messages) {
    const body = message.body;
    if (!isQueueTask(body)) {
      message.ack();
      continue;
    }

    switch (body.type) {
      case FEED_AI_SUMMARY_TASK:
        await processFeedAISummaryTask(
          env,
          db,
          cache,
          serverConfig,
          body.payload,
          clearFeedCache,
        );
        message.ack();
        break;
      case IMAGE_COMPRESSION_TASK:
        await processImageCompressionTask(
          env,
          db,
          serverConfig,
          body.payload.imageId,
        );
        message.ack();
        break;
      default:
        message.ack();
        break;
    }
  }
}
