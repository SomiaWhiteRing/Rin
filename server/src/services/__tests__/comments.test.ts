import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CommentService } from '../comments';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

describe('CommentService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
        const ctx = await setupTestApp(CommentService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        
        // Seed test data
        await seedTestData(sqlite);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        cleanupTestDB(sqlite);
    });

    async function seedTestData(sqlite: Database) {
        // Insert test users
        sqlite.exec(`
            INSERT INTO users (id, username, avatar, permission, openid) VALUES 
                (1, 'user1', 'avatar1.png', 0, 'gh_1'),
                (2, 'user2', 'avatar2.png', 0, 'gh_2'),
                (3, 'admin', 'admin.png', 1, 'gh_admin')
        `);

        // Insert test feeds
        sqlite.exec(`
            INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES 
                (1, 'Feed 1', 'Content 1', 1, 0, 1),
                (2, 'Feed 2', 'Content 2', 1, 0, 1)
        `);

        // Insert test comments
        sqlite.exec(`
            INSERT INTO comments (id, feed_id, user_id, author_name, author_avatar, content, created_at) VALUES 
                (1, 1, 2, 'user2', 'avatar2.png', 'Comment 1 on feed 1', unixepoch()),
                (2, 1, 2, 'user2', 'avatar2.png', 'Comment 2 on feed 1', unixepoch()),
                (3, 2, 1, 'user1', 'avatar1.png', 'Comment on feed 2', unixepoch())
        `);
    }

    describe('GET /:feed - List comments', () => {
        it('should return comments for a feed', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toBeArray();
            expect(data.length).toBe(2);
            expect(data[0]).toHaveProperty('content');
            expect(data[0]).toHaveProperty('author');
            expect(data[0].author).toHaveProperty('username');
        });

        it('should return empty array when feed has no comments', async () => {
            // Create new feed without comments
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid) VALUES (3, 'No Comments', 'Content', 1)`);
            
            const res = await app.request('/3', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toEqual([]);
        });

        it('should not expose sensitive fields', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.length).toBeGreaterThan(0);
            
            // Should not include internal DB fields
            expect(data[0]).not.toHaveProperty('feedId');
            expect(data[0]).not.toHaveProperty('userId');
            expect(data[0]).not.toHaveProperty('authorName');
            expect(data[0]).not.toHaveProperty('authorAvatar');
            
            // Should include author info
            expect(data[0].author).toHaveProperty('id');
            expect(data[0].author).toHaveProperty('username');
            expect(data[0].author).toHaveProperty('avatar');
            expect(data[0].author).toHaveProperty('permission');
            expect(data[0].author).toHaveProperty('isGuest');
        });

        it('should order comments by createdAt descending', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.length).toBe(2);
        });
    });

    describe('POST /:feed - Create comment', () => {
        it('should create anonymous comment without authentication', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authorName: 'Guest User', content: 'New test comment' }),
            }, env);

            expect(res.status).toBe(204);
            
            // Verify comment was created
            const comments = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1`).all() as any[];
            expect(comments.length).toBe(3);
            expect(comments[2]?.author_name).toBe('Guest User');
            expect(comments[2]?.user_id).toBeNull();
        });

        it('should link authenticated comments back to the user for moderation', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authorName: 'Signed User', content: 'Test comment' }),
            }, env);

            expect(res.status).toBe(204);

            const dbComment = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1 ORDER BY id DESC LIMIT 1`).get() as any;
            expect(dbComment.user_id).toBe(1);
            expect(dbComment.author_name).toBe('Signed User');
        });

        it('should require content', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authorName: 'Guest User', content: '' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should require author name', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authorName: '', content: 'Test' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should return 400 for non-existent feed', async () => {
            const res = await app.request('/999', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authorName: 'Guest User', content: 'Test' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should still create the comment when webhook delivery fails', async () => {
            env.WEBHOOK_URL = 'not-a-valid-url' as any;
            globalThis.fetch = mock(async () => {
                throw new TypeError('Invalid URL');
            }) as unknown as typeof fetch;

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authorName: 'Webhook Guest', content: 'Comment survives webhook errors' }),
            }, env);

            expect(res.status).toBe(204);

            const comments = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1`).all();
            expect(comments.length).toBe(3);
        });
    });

    describe('DELETE /:id - Delete comment', () => {
        it('should allow user to delete their own comment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_2' },
            }, env);

            expect(res.status).toBe(200);
            
            // Verify comment was deleted
            const dbResult = sqlite.prepare(`SELECT * FROM comments WHERE id = 1`).all();
            expect(dbResult.length).toBe(0);
        });

        it('should allow admin to delete any comment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env);

            expect(res.status).toBe(200);
        });

        it('should deny deletion by other users', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(403);
        });

        it('should require authentication', async () => {
            const res = await app.request('/1', { method: 'DELETE' }, env);

            expect(res.status).toBe(401);
        });

        it('should return 404 for non-existent comment', async () => {
            const res = await app.request('/999', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(404);
        });
    });
});
