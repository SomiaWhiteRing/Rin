import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const created_at = integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();
const updated_at = integer("updated_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();

export const feeds = sqliteTable("feeds", {
    id: integer("id").primaryKey(),
    alias: text("alias"),
    title: text("title"),
    summary: text("summary").default("").notNull(),
    ai_summary: text("ai_summary").default("").notNull(),
    ai_summary_status: text("ai_summary_status").default("idle").notNull(),
    ai_summary_error: text("ai_summary_error").default("").notNull(),
    content: text("content").notNull(),
    listed: integer("listed").default(1).notNull(),
    draft: integer("draft").default(1).notNull(),
    top: integer("top").default(0).notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const moments = sqliteTable("moments", {
    id: integer("id").primaryKey(),
    content: text("content").notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at
});

export const visits = sqliteTable("visits", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    ip: text("ip").notNull(),
    createdAt: created_at,
});

export const visitStats = sqliteTable("visit_stats", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull().primaryKey(),
    pv: integer("pv").default(0).notNull(),
    hllData: text("hll_data").default("").notNull(),
    updatedAt: updated_at,
});

export const info = sqliteTable("info", {
    key: text("key").notNull().unique(),
    value: text("value").notNull(),
});

export const friends = sqliteTable("friends", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    desc: text("desc"),
    avatar: text("avatar").notNull(),
    url: text("url").notNull(),
    uid: integer("uid").references(() => users.id, { onDelete: 'set null' }),
    accepted: integer("accepted").default(0).notNull(),
    health: text("health").default("").notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    username: text("username").notNull(),
    openid: text("openid").notNull(),
    avatar: text("avatar"),
    password: text("password"),
    permission: integer("permission").default(0),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const comments = sqliteTable("comments", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: 'set null' }),
    authorName: text("author_name").notNull(),
    authorAvatar: text("author_avatar"),
    content: text("content").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const imageAssets = sqliteTable("image_assets", {
    id: integer("id").primaryKey(),
    url: text("url").notNull().unique(),
    storageKey: text("storage_key").unique(),
    source: text("source").default("article").notNull(),
    filename: text("filename").default("").notNull(),
    note: text("note").default("").notNull(),
    favorite: integer("favorite").default(0).notNull(),
    contentType: text("content_type").default("").notNull(),
    size: integer("size").default(0).notNull(),
    width: integer("width"),
    height: integer("height"),
    blurhash: text("blurhash").default("").notNull(),
    compressionStatus: text("compression_status").default("idle").notNull(),
    compressionError: text("compression_error").default("").notNull(),
    originalSize: integer("original_size"),
    compressedAt: integer("compressed_at", { mode: "timestamp" }),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const imageUsages = sqliteTable("image_usages", {
    id: integer("id").primaryKey(),
    assetId: integer("asset_id").references(() => imageAssets.id, { onDelete: "cascade" }).notNull(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
    rawUrl: text("raw_url").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    assetFeedUnique: unique().on(table.assetId, table.feedId),
}));

export const hashtags = sqliteTable("hashtags", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const feedHashtags = sqliteTable("feed_hashtags", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    hashtagId: integer("hashtag_id").references(() => hashtags.id, { onDelete: 'cascade' }).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const cache = sqliteTable("cache", {
    id: integer("id").primaryKey(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    type: text("type").default("cache").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    // 复合唯一约束：key + type
    keyTypeUnique: unique().on(table.key, table.type),
}));

export const feedsRelations = relations(feeds, ({ many, one }) => ({
    hashtags: many(feedHashtags),
    user: one(users, {
        fields: [feeds.uid],
        references: [users.id],
    }),
    comments: many(comments),
}));

export const momentsRelations = relations(moments, ({ one }) => ({
    user: one(users, {
        fields: [moments.uid],
        references: [users.id],
    })
}));

export const commentsRelations = relations(comments, ({ one }) => ({
    feed: one(feeds, {
        fields: [comments.feedId],
        references: [feeds.id],
    }),
    user: one(users, {
        fields: [comments.userId],
        references: [users.id],
    }),
}));

export const imageAssetsRelations = relations(imageAssets, ({ many }) => ({
    usages: many(imageUsages),
}));

export const imageUsagesRelations = relations(imageUsages, ({ one }) => ({
    asset: one(imageAssets, {
        fields: [imageUsages.assetId],
        references: [imageAssets.id],
    }),
    feed: one(feeds, {
        fields: [imageUsages.feedId],
        references: [feeds.id],
    }),
}));

export const hashtagsRelations = relations(hashtags, ({ many }) => ({
    feeds: many(feedHashtags),
}));

export const feedHashtagsRelations = relations(feedHashtags, ({ one }) => ({
    feed: one(feeds, {
        fields: [feedHashtags.feedId],
        references: [feeds.id],
    }),
    hashtag: one(hashtags, {
        fields: [feedHashtags.hashtagId],
        references: [hashtags.id],
    }),
}));
