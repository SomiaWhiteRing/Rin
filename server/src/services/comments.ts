import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { desc, eq } from "drizzle-orm";
import { comments, feeds, users } from "../db/schema";
import { profileAsync } from "../core/server-timing";
import { notify } from "../utils/webhook";
import { resolveWebhookConfig } from "./config-helpers";

function serializeComment(comment: {
    id: number;
    content: string;
    createdAt: Date;
    updatedAt: Date;
    authorName: string;
    authorAvatar: string | null;
    userId: number | null;
    user?: {
        id: number;
        username: string;
        avatar: string | null;
        permission: number | null;
    } | null;
}) {
    return {
        id: comment.id,
        content: comment.content,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        author: {
            id: comment.user?.id ?? comment.userId ?? null,
            username: comment.authorName,
            avatar: comment.authorAvatar ?? comment.user?.avatar ?? null,
            permission: comment.user?.permission ?? null,
            isGuest: comment.userId == null,
        },
    };
}

export function CommentService(): Hono {
    const app = new Hono();

    app.get('/:feed', async (c: AppContext) => {
        const db = c.get('db');
        const feedId = Number.parseInt(c.req.param('feed') ?? "", 10);

        if (Number.isNaN(feedId)) {
            return c.text('Feed id is invalid', 400);
        }
        
        const comment_list = await profileAsync(c, 'comment_list_db', () => db.query.comments.findMany({
            where: eq(comments.feedId, feedId),
            with: {
                user: {
                    columns: { id: true, username: true, avatar: true, permission: true }
                }
            },
            orderBy: [desc(comments.createdAt)]
        }));
        
        return c.json(comment_list.map((comment) => serializeComment(comment as never)));
    });

    app.post('/:feed', async (c: AppContext) => {
        const db = c.get('db');
        const env = c.get('env');
        const serverConfig = c.get('serverConfig');
        const uid = c.get('uid');
        const feedId = Number.parseInt(c.req.param('feed') ?? "", 10);
        const body = await profileAsync(c, 'comment_create_parse', () => c.req.json());
        const authorName = body.authorName?.trim();
        const content = body.content?.trim();

        if (Number.isNaN(feedId)) {
            return c.text('Feed id is invalid', 400);
        }
        
        if (!authorName) {
            return c.text('Author name is required', 400);
        }
        if (!content) {
            return c.text('Content is required', 400);
        }
        
        const user = uid == undefined
            ? undefined
            : await profileAsync(c, 'comment_create_user', () => db.query.users.findFirst({ where: eq(users.id, uid) }));
        
        const exist = await profileAsync(c, 'comment_create_feed', () => db.query.feeds.findFirst({ where: eq(feeds.id, feedId) }));
        if (!exist) {
            return c.text('Feed not found', 400);
        }

        await profileAsync(c, 'comment_create_insert', () => db.insert(comments).values({
            feedId,
            userId: user?.id,
            authorName,
            authorAvatar: user?.avatar ?? null,
            content
        }));

        const {
            webhookUrl,
            webhookMethod,
            webhookContentType,
            webhookHeaders,
            webhookBodyTemplate,
        } = await profileAsync(c, 'comment_create_webhook_config', () => resolveWebhookConfig(serverConfig, env));
        const frontendUrl = new URL(c.req.url).origin;
        try {
            await profileAsync(c, 'comment_create_notify', () => notify(
                webhookUrl || "",
                {
                    event: "comment.created",
                    message: `${frontendUrl}/feed/${feedId}\n${authorName} 评论了: ${exist.title}\n${content}`,
                    title: exist.title || "",
                    url: `${frontendUrl}/feed/${feedId}`,
                    username: authorName,
                    content,
                },
                {
                    method: webhookMethod,
                    contentType: webhookContentType,
                    headers: webhookHeaders,
                    bodyTemplate: webhookBodyTemplate,
                },
            ));
        } catch (error) {
            console.error("Failed to send comment webhook", error);
        }
        return c.body(null, 204);
    });

    app.delete('/:id', async (c: AppContext) => {
        const db = c.get('db');
        const uid = c.get('uid');
        const admin = c.get('admin');
        
        if (uid === undefined) {
            return c.text('Unauthorized', 401);
        }
        
        const id_num = Number.parseInt(c.req.param('id') ?? "", 10);

        if (Number.isNaN(id_num)) {
            return c.text('Comment id is invalid', 400);
        }

        const comment = await profileAsync(c, 'comment_delete_lookup', () => db.query.comments.findFirst({ where: eq(comments.id, id_num) }));
        
        if (!comment) {
            return c.text('Not found', 404);
        }
        
        if (!admin && comment.userId !== uid) {
            return c.text('Permission denied', 403);
        }
        
        await profileAsync(c, 'comment_delete_db', () => db.delete(comments).where(eq(comments.id, id_num)));
        return c.text('OK');
    });

    return app;
}
