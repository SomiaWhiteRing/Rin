import { SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader } from "@rin/ui";
import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import Modal from "react-modal";
import type { ImageAsset, ImageStatsResponse } from "../api/client";
import { client } from "../app/runtime";
import { Button } from "../components/button";
import { useAlert, useConfirm } from "../components/dialog";
import { useSiteConfig } from "../hooks/useSiteConfig";

type ImageViewMode = "list" | "grid";
type ImageUsageFilter = "all" | "used" | "unused";
type ImageFavoriteFilter = "all" | "favorited" | "normal";
type ImageSort = "created_desc" | "created_asc" | "size_desc" | "size_asc";

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function getCompressionTone(status: ImageAsset["compressionStatus"]) {
  if (status === "completed") return "success";
  if (status === "pending" || status === "processing") return "warning";
  return "neutral";
}

function ImagePreview({ asset }: { asset: ImageAsset }) {
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/10 bg-neutral-100 dark:border-white/10 dark:bg-white/5">
      {asset.url ? (
        <img src={asset.url} alt={asset.filename} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <i className="ri-image-line text-xl text-neutral-400" />
      )}
    </div>
  );
}

export function ImagesPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [stats, setStats] = useState<ImageStatsResponse>({ total: 0, used: 0, unused: 0, totalSize: 0, compressible: 0 });
  const [keyword, setKeyword] = useState("");
  const [usage, setUsage] = useState<ImageUsageFilter>("all");
  const [favorite, setFavorite] = useState<ImageFavoriteFilter>("all");
  const [feedId, setFeedId] = useState(0);
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [sort, setSort] = useState<ImageSort>("created_desc");
  const [viewMode, setViewMode] = useState<ImageViewMode>("list");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [feeds, setFeeds] = useState<Array<{ id: number; title: string | null }>>([]);
  const [acting, setActing] = useState(false);
  const [activeAsset, setActiveAsset] = useState<ImageAsset | null>(null);
  const [editFilename, setEditFilename] = useState("");
  const [editNote, setEditNote] = useState("");
  const { showAlert, AlertUI } = useAlert();
  const { showConfirm, ConfirmUI } = useConfirm();

  const loadImages = () => {
    setLoading(true);
    client.images
      .list({
        page: 1,
        limit: 100,
        keyword,
        usage,
        favorite,
        feedId: feedId || undefined,
        createdFrom: createdFrom ? new Date(`${createdFrom}T00:00:00`).toISOString() : undefined,
        createdTo: createdTo ? new Date(`${createdTo}T23:59:59`).toISOString() : undefined,
        sort,
      })
      .then(({ data, error }) => {
        if (error) {
          showAlert(error.value);
          return;
        }
        setItems(data?.data || []);
        setSelectedIds([]);
      })
      .finally(() => setLoading(false));

    client.images.stats().then(({ data }) => {
      if (data) setStats(data);
    });
  };

  useEffect(() => {
    loadImages();
  }, [usage, favorite, feedId, createdFrom, createdTo, sort]);

  useEffect(() => {
    Promise.all([
      client.feed.list({ page: 1, limit: 100, type: "normal" }),
      client.feed.list({ page: 1, limit: 100, type: "draft" }),
      client.feed.list({ page: 1, limit: 100, type: "unlisted" }),
    ]).then((responses) => {
      const allFeeds = responses.flatMap((response) => response.data?.data || []);
      const seen = new Set<number>();
      setFeeds(allFeeds.filter((feed) => {
        if (seen.has(feed.id)) return false;
        seen.add(feed.id);
        return true;
      }));
    });
  }, []);

  const toggleSelected = (id: number) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const openDetails = (asset: ImageAsset) => {
    setActiveAsset(asset);
    setEditFilename(asset.filename);
    setEditNote(asset.note);
  };

  const saveDetails = async () => {
    if (!activeAsset) return;
    setActing(true);
    try {
      const { error } = await client.images.update(activeAsset.id, { filename: editFilename, note: editNote });
      if (error) {
        showAlert(error.value);
        return;
      }
      showAlert(t("images.details.saved"));
      setActiveAsset(null);
      loadImages();
    } finally {
      setActing(false);
    }
  };

  const toggleFavorite = async (asset: ImageAsset) => {
    const { error } = await client.images.update(asset.id, { favorite: asset.favorite !== 1 });
    if (error) {
      showAlert(error.value);
      return;
    }
    loadImages();
  };

  const copyLink = async (asset: ImageAsset) => {
    try {
      await navigator.clipboard.writeText(asset.url);
      showAlert(t("images.copy.success"));
    } catch (error) {
      showAlert(error instanceof Error ? error.message : t("images.copy.failed"));
    }
  };

  const compressOne = async (asset: ImageAsset) => {
    setActing(true);
    try {
      const { data, error } = await client.images.bulkCompress([asset.id]);
      if (error) {
        showAlert(error.value);
        return;
      }
      showAlert(t("images.bulk_compress.result", { queued: data?.queued || 0, skipped: data?.skipped || 0 }));
      loadImages();
    } finally {
      setActing(false);
    }
  };

  const runBulkDelete = () => {
    const ids = selectedIds;
    if (ids.length === 0) return;
    showConfirm(
      t("images.bulk_delete.title"),
      t("images.bulk_delete.confirm", { count: ids.length }),
      async () => {
        setActing(true);
        try {
          const { data, error } = await client.images.bulkDelete(ids);
          if (error) {
            showAlert(error.value);
            return;
          }
          showAlert(t("images.bulk_delete.result", { deleted: data?.deleted || 0, skipped: data?.skipped || 0 }));
          loadImages();
        } finally {
          setActing(false);
        }
      },
    );
  };

  const runBulkCompress = () => {
    const ids = selectedIds;
    if (ids.length === 0) return;
    showConfirm(
      t("images.bulk_compress.title"),
      t("images.bulk_compress.confirm", { count: ids.length }),
      async () => {
        setActing(true);
        try {
          const { data, error } = await client.images.bulkCompress(ids);
          if (error) {
            showAlert(error.value);
            return;
          }
          showAlert(t("images.bulk_compress.result", { queued: data?.queued || 0, skipped: data?.skipped || 0 }));
          loadImages();
        } finally {
          setActing(false);
        }
      },
    );
  };

  const deleteOne = (asset: ImageAsset) => {
    showConfirm(
      t("images.delete.title"),
      t("images.delete.confirm", { name: asset.filename }),
      async () => {
        const { error } = await client.images.delete(asset.id);
        if (error) {
          showAlert(error.value);
          return;
        }
        showAlert(t("delete.success"));
        loadImages();
      },
    );
  };

  const renderMeta = (asset: ImageAsset) => (
    <div className="flex flex-wrap gap-2 text-xs text-neutral-500 dark:text-neutral-400">
      <span>{formatBytes(asset.size)}</span>
      {asset.width && asset.height ? <span>{asset.width} x {asset.height}</span> : null}
      {asset.contentType ? <span>{asset.contentType}</span> : null}
      <span>{t(asset.usageCount > 0 ? "images.used$count" : "images.unused", { count: asset.usageCount })}</span>
      <span>{t("images.created_at", { date: new Date(asset.createdAt).toLocaleString() })}</span>
    </div>
  );

  const canCompress = (asset: ImageAsset) => Boolean(asset.storageKey) && ["image/png", "image/jpeg", "image/webp"].some((type) => asset.contentType.startsWith(type));
  const canDelete = (asset: ImageAsset) => asset.usageCount === 0 && Boolean(asset.storageKey) && asset.favorite !== 1;

  const deleteDisabledReason = (asset: ImageAsset) => {
    if (asset.favorite === 1) return t("images.delete.disabled_favorite");
    if (asset.usageCount > 0) return t("images.delete.disabled_used");
    if (!asset.storageKey) return t("images.delete.disabled_external");
    return "";
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <Helmet>
        <title>{`${t("images.title")} - ${siteConfig.name}`}</title>
      </Helmet>

      <AlertUI />
      <ConfirmUI />
      <Modal
        isOpen={activeAsset !== null}
        shouldCloseOnEsc
        shouldCloseOnOverlayClick
        onRequestClose={() => setActiveAsset(null)}
        style={{
          content: {
            top: "50%",
            left: "50%",
            right: "auto",
            bottom: "auto",
            marginRight: "-50%",
            transform: "translate(-50%, -50%)",
            padding: 0,
            border: "none",
            borderRadius: "16px",
            background: "transparent",
            width: "min(42rem, calc(100vw - 2rem))",
          },
          overlay: {
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            zIndex: 1000,
          },
        }}
      >
        {activeAsset ? (
          <div className="bg-w p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-xl font-semibold t-primary">{t("images.details.title")}</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  <SettingsBadge tone={activeAsset.favorite === 1 ? "warning" : "neutral"}>{activeAsset.favorite === 1 ? t("images.favorite.yes") : t("images.favorite.no")}</SettingsBadge>
                  <SettingsBadge tone={activeAsset.source === "external" ? "neutral" : "success"}>{t(`images.source.${activeAsset.source}`)}</SettingsBadge>
                </div>
              </div>
              <button type="button" className="t-primary" onClick={() => setActiveAsset(null)} title={t("close")}>
                <i className="ri-close-line text-xl" />
              </button>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-[10rem_1fr]">
              <div className="aspect-square overflow-hidden rounded-lg border border-black/10 bg-neutral-100 dark:border-white/10 dark:bg-white/5">
                <img src={activeAsset.url} alt={activeAsset.filename} className="h-full w-full object-cover" />
              </div>
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="font-medium t-primary">{t("images.details.filename")}</span>
                  <input value={editFilename} onChange={(event) => setEditFilename(event.target.value)} className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 t-primary dark:border-white/10" />
                </label>
                <label className="block text-sm">
                  <span className="font-medium t-primary">{t("images.details.note")}</span>
                  <textarea value={editNote} onChange={(event) => setEditNote(event.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 t-primary dark:border-white/10" />
                </label>
                <div className="text-sm text-neutral-500 dark:text-neutral-400">{renderMeta(activeAsset)}</div>
                {deleteDisabledReason(activeAsset) ? (
                  <p className="text-sm text-amber-600 dark:text-amber-300">{deleteDisabledReason(activeAsset)}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-5 border-t border-black/5 pt-4 dark:border-white/5">
              <h3 className="text-sm font-semibold t-primary">{t("images.details.usages")}</h3>
              {activeAsset.usages.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {activeAsset.usages.map((usageItem) => (
                    <a key={usageItem.id} href={`/admin/writing/${usageItem.id}`} className="rounded-full bg-neutral-100 px-3 py-1 text-sm t-primary dark:bg-white/5">
                      {usageItem.title || `#${usageItem.id}`}
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t("images.details.no_usages")}</p>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button secondary title={t("images.copy.title")} disabled={acting} onClick={() => copyLink(activeAsset)} />
              <Button secondary title={activeAsset.favorite === 1 ? t("images.favorite.remove") : t("images.favorite.add")} disabled={acting} onClick={() => toggleFavorite(activeAsset)} />
              <Button secondary title={t("cancel")} disabled={acting} onClick={() => setActiveAsset(null)} />
              <Button title={acting ? t("saving") : t("save")} disabled={acting} onClick={saveDetails} />
            </div>
          </div>
        ) : null}
      </Modal>

      <div className="grid gap-4 md:grid-cols-4">
        <SettingsCard>
          <SettingsCardHeader title={String(stats.total)} description={t("images.stats.total")} />
        </SettingsCard>
        <SettingsCard>
          <SettingsCardHeader title={formatBytes(stats.totalSize)} description={t("images.stats.total_size")} />
        </SettingsCard>
        <SettingsCard tone={stats.unused > 0 ? "warning" : "success"}>
          <SettingsCardHeader title={String(stats.unused)} description={t("images.stats.unused")} />
        </SettingsCard>
        <SettingsCard>
          <SettingsCardHeader title={String(stats.compressible)} description={t("images.stats.compressible")} />
        </SettingsCard>
      </div>

      <SettingsCard>
        <SettingsCardBody>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                loadImages();
              }}
            >
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={t("images.search")}
                className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm t-primary dark:border-white/10"
              />
              <Button title={t("article.search.title")} onClick={loadImages} />
            </form>

            <select value={usage} onChange={(event) => setUsage(event.target.value as ImageUsageFilter)} className="rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
              <option value="all">{t("images.filter.all")}</option>
              <option value="used">{t("images.filter.used")}</option>
              <option value="unused">{t("images.filter.unused")}</option>
            </select>

            <select value={favorite} onChange={(event) => setFavorite(event.target.value as ImageFavoriteFilter)} className="rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
              <option value="all">{t("images.favorite_filter.all")}</option>
              <option value="favorited">{t("images.favorite_filter.favorited")}</option>
              <option value="normal">{t("images.favorite_filter.normal")}</option>
            </select>

            <select value={feedId} onChange={(event) => setFeedId(Number(event.target.value))} className="rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
              <option value={0}>{t("images.filter.all_articles")}</option>
              {feeds.map((feed) => (
                <option key={feed.id} value={feed.id}>{feed.title || `#${feed.id}`}</option>
              ))}
            </select>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-[auto_auto_auto_auto_1fr] xl:items-center">
            <input type="date" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} className="rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10" aria-label={t("images.filter.created_from")} />
            <input type="date" value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} className="rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10" aria-label={t("images.filter.created_to")} />
            <select value={sort} onChange={(event) => setSort(event.target.value as ImageSort)} className="rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
              <option value="created_desc">{t("images.sort.created_desc")}</option>
              <option value="created_asc">{t("images.sort.created_asc")}</option>
              <option value="size_desc">{t("images.sort.size_desc")}</option>
              <option value="size_asc">{t("images.sort.size_asc")}</option>
            </select>
            <div className="flex rounded-lg border border-black/10 p-1 dark:border-white/10">
              <button type="button" title={t("images.view.list")} onClick={() => setViewMode("list")} className={`rounded-md px-3 py-1.5 ${viewMode === "list" ? "bg-theme text-white" : "t-primary"}`}>
                <i className="ri-list-check" />
              </button>
              <button type="button" title={t("images.view.grid")} onClick={() => setViewMode("grid")} className={`rounded-md px-3 py-1.5 ${viewMode === "grid" ? "bg-theme text-white" : "t-primary"}`}>
                <i className="ri-layout-grid-line" />
              </button>
            </div>
          </div>

          {selectedIds.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-black/5 pt-4 text-sm dark:border-white/5">
              <span className="text-neutral-500 dark:text-neutral-400">{t("images.selected$count", { count: selectedIds.length })}</span>
              <Button secondary title={t("images.bulk_delete.title")} disabled={acting} onClick={runBulkDelete} />
              <Button title={t("images.bulk_compress.title")} disabled={acting} onClick={runBulkCompress} />
            </div>
          ) : null}
        </SettingsCardBody>
      </SettingsCard>

      {loading ? (
        <div className="flex items-center gap-3 py-8 text-sm text-neutral-500 dark:text-neutral-400">
          <ReactLoading width="1.25em" height="1.25em" type="spin" color="#FC466B" />
          <span>{t("images.loading")}</span>
        </div>
      ) : null}

      {!loading && items.length === 0 ? (
        <SettingsCard>
          <SettingsCardHeader title={t("images.empty.title")} description={t("images.empty.description")} />
        </SettingsCard>
      ) : null}

      {!loading && viewMode === "list" && items.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
          {items.map((asset) => (
            <div key={asset.id} className="flex items-center gap-4 border-b border-black/5 p-4 last:border-b-0 dark:border-white/5">
              <input type="checkbox" checked={selectedIds.includes(asset.id)} onChange={() => toggleSelected(asset.id)} />
              <ImagePreview asset={asset} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SettingsBadge tone={asset.favorite === 1 ? "warning" : "neutral"}>{asset.favorite === 1 ? t("images.favorite.yes") : t("images.favorite.no")}</SettingsBadge>
                  <SettingsBadge tone={asset.source === "external" ? "neutral" : "success"}>{t(`images.source.${asset.source}`)}</SettingsBadge>
                  <SettingsBadge tone={getCompressionTone(asset.compressionStatus)}>{t(`images.compression.${asset.compressionStatus}`)}</SettingsBadge>
                </div>
                <div className="mt-2">{renderMeta(asset)}</div>
              </div>
              <Button
                secondary
                title={asset.favorite === 1 ? t("images.favorite.remove") : t("images.favorite.add")}
                onClick={() => toggleFavorite(asset)}
              />
              <Button
                secondary
                title={t("images.copy.title")}
                onClick={() => copyLink(asset)}
              />
              <Button
                secondary
                title={t("images.details.open")}
                onClick={() => openDetails(asset)}
              />
              <Button
                secondary
                title={t("images.compress_one")}
                disabled={acting || !canCompress(asset)}
                onClick={() => compressOne(asset)}
              />
              <Button
                secondary
                title={t("delete.title")}
                disabled={!canDelete(asset)}
                onClick={() => deleteOne(asset)}
              />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && viewMode === "grid" && items.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((asset) => (
            <SettingsCard key={asset.id}>
              <SettingsCardBody>
                <div className="space-y-3">
                  <div className="relative aspect-video overflow-hidden rounded-lg border border-black/10 bg-neutral-100 dark:border-white/10 dark:bg-white/5">
                    <img src={asset.url} alt={asset.filename} className="h-full w-full object-cover" loading="lazy" />
                    <input className="absolute left-3 top-3" type="checkbox" checked={selectedIds.includes(asset.id)} onChange={() => toggleSelected(asset.id)} />
                  </div>
                  <div className="min-w-0">
                    <div className="mt-2">{renderMeta(asset)}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SettingsBadge tone={asset.favorite === 1 ? "warning" : "neutral"}>{asset.favorite === 1 ? t("images.favorite.yes") : t("images.favorite.no")}</SettingsBadge>
                    <SettingsBadge tone={asset.source === "external" ? "neutral" : "success"}>{t(`images.source.${asset.source}`)}</SettingsBadge>
                    <SettingsBadge tone={getCompressionTone(asset.compressionStatus)}>{t(`images.compression.${asset.compressionStatus}`)}</SettingsBadge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button secondary title={asset.favorite === 1 ? t("images.favorite.remove") : t("images.favorite.add")} onClick={() => toggleFavorite(asset)} />
                    <Button secondary title={t("images.copy.title")} onClick={() => copyLink(asset)} />
                    <Button secondary title={t("images.compress_one")} disabled={acting || !canCompress(asset)} onClick={() => compressOne(asset)} />
                    <Button secondary title={t("images.details.open")} onClick={() => openDetails(asset)} />
                  </div>
                </div>
              </SettingsCardBody>
            </SettingsCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}
