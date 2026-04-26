import { SettingsBadge, SettingsCard, SettingsCardHeader } from "@rin/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function getImageKind(asset: ImageAsset) {
  if (!asset.contentType) return "";
  return asset.contentType.replace(/^image\//, "").toUpperCase();
}

function getDimensions(asset: ImageAsset) {
  if (!asset.width || !asset.height) return "";
  return `${asset.width} x ${asset.height}`;
}

function getCompressionTone(status: ImageAsset["compressionStatus"]) {
  if (status === "completed") return "success";
  if (status === "pending" || status === "processing") return "warning";
  return "neutral";
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0 text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
      <span>{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ActiveFilter({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
    >
      <span>{children}</span>
      <i className="ri-close-line text-sm" aria-hidden="true" />
    </button>
  );
}

function CompactAction({
  title,
  icon,
  disabled,
  onClick,
}: {
  title: string;
  icon: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-700 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
    >
      <i className={icon} aria-hidden="true" />
    </button>
  );
}

function ImagePreview({ asset, compact = false }: { asset: ImageAsset; compact?: boolean }) {
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/10 bg-neutral-100 dark:border-white/10 dark:bg-white/5 ${compact ? "h-12 w-12" : "h-16 w-16"}`}>
      {asset.url ? (
        <img
          src={asset.url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
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
  const canCompress = (asset: ImageAsset) => Boolean(asset.storageKey) && ["image/png", "image/jpeg", "image/webp"].some((type) => asset.contentType.startsWith(type));
  const canDelete = (asset: ImageAsset) => asset.usageCount === 0 && Boolean(asset.storageKey) && asset.favorite !== 1;
  const hasActiveFilters = Boolean(usage !== "all" || favorite !== "all" || feedId || createdFrom || createdTo);
  const selectedAssets = useMemo(() => items.filter((asset) => selectedIds.includes(asset.id)), [items, selectedIds]);
  const selectedDeletableCount = selectedAssets.filter(canDelete).length;
  const selectedCompressibleCount = selectedAssets.filter(canCompress).length;
  const selectedTotalSize = selectedAssets.reduce((total, asset) => total + asset.size, 0);

  const loadImages = () => {
    setLoading(true);
    client.images
      .list({
        page: 1,
        limit: 100,
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
      {getDimensions(asset) ? <span>{getDimensions(asset)}</span> : null}
      {getImageKind(asset) ? <span>{getImageKind(asset)}</span> : null}
      <span>{t(asset.usageCount > 0 ? "images.used$count" : "images.unused", { count: asset.usageCount })}</span>
      <span>{t("images.created_at", { date: formatDateTime(asset.createdAt) })}</span>
    </div>
  );

  const renderCompactMeta = (asset: ImageAsset) => (
    <div className="flex min-w-0 items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
      <span className="shrink-0">{formatBytes(asset.size)}</span>
      {getDimensions(asset) ? <span className="shrink-0">{getDimensions(asset)}</span> : null}
      {getImageKind(asset) ? <span className="shrink-0">{getImageKind(asset)}</span> : null}
      <span className="shrink-0">{t(asset.usageCount > 0 ? "images.used$count" : "images.unused", { count: asset.usageCount })}</span>
      <span className="min-w-0 truncate">{formatDateTime(asset.createdAt)}</span>
    </div>
  );

  const clearFilters = () => {
    setUsage("all");
    setFavorite("all");
    setFeedId(0);
    setCreatedFrom("");
    setCreatedTo("");
    setSort("created_desc");
  };

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
        <div>
          <div className="grid gap-3 sm:grid-cols-3">
            <FilterField label={t("images.filter.usage")}>
              <select value={usage} onChange={(event) => setUsage(event.target.value as ImageUsageFilter)} className="w-full rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
                <option value="all">{t("images.filter.all")}</option>
                <option value="used">{t("images.filter.used")}</option>
                <option value="unused">{t("images.filter.unused")}</option>
              </select>
            </FilterField>

            <FilterField label={t("images.filter.favorite")}>
              <select value={favorite} onChange={(event) => setFavorite(event.target.value as ImageFavoriteFilter)} className="w-full rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
                <option value="all">{t("images.favorite_filter.all")}</option>
                <option value="favorited">{t("images.favorite_filter.favorited")}</option>
                <option value="normal">{t("images.favorite_filter.normal")}</option>
              </select>
            </FilterField>

            <FilterField label={t("images.filter.article")}>
              <select value={feedId} onChange={(event) => setFeedId(Number(event.target.value))} className="w-full rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10">
                <option value={0}>{t("images.filter.all_articles")}</option>
                {feeds.map((feed) => (
                  <option key={feed.id} value={feed.id}>{feed.title || `#${feed.id}`}</option>
                ))}
              </select>
            </FilterField>
          </div>

          <div className="mt-4 grid gap-4 border-t border-black/5 pt-4 dark:border-white/5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
            <div>
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-[minmax(0,12rem)_minmax(0,12rem)]">
                <FilterField label={t("images.filter.created_from")}>
                  <input type="date" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} className="w-full rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10" />
                </FilterField>
                <FilterField label={t("images.filter.created_to")}>
                  <input type="date" value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} className="w-full rounded-lg border border-black/10 bg-w px-3 py-2 text-sm t-primary dark:border-white/10" />
                </FilterField>
              </div>
              {hasActiveFilters ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">{t("images.filter.active")}</span>
                  {usage !== "all" ? <ActiveFilter onClear={() => setUsage("all")}>{t(`images.filter.${usage}`)}</ActiveFilter> : null}
                  {favorite !== "all" ? <ActiveFilter onClear={() => setFavorite("all")}>{t(`images.favorite_filter.${favorite}`)}</ActiveFilter> : null}
                  {feedId ? <ActiveFilter onClear={() => setFeedId(0)}>{feeds.find((feed) => feed.id === feedId)?.title || `#${feedId}`}</ActiveFilter> : null}
                  {createdFrom ? <ActiveFilter onClear={() => setCreatedFrom("")}>{t("images.filter.from$value", { value: createdFrom })}</ActiveFilter> : null}
                  {createdTo ? <ActiveFilter onClear={() => setCreatedTo("")}>{t("images.filter.to$value", { value: createdTo })}</ActiveFilter> : null}
                  <button type="button" className="text-xs font-semibold text-theme" onClick={clearFilters}>{t("images.filter.clear")}</button>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-3">
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
          </div>

          {selectedIds.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-theme/20 bg-theme/5 p-3 text-sm">
              <div>
                <p className="font-semibold t-primary">{t("images.selected$count", { count: selectedIds.length })}</p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t("images.selection.summary", { size: formatBytes(selectedTotalSize), deletable: selectedDeletableCount, compressible: selectedCompressibleCount })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button secondary title={t("images.selection.clear")} disabled={acting} onClick={() => setSelectedIds([])} />
                <Button secondary title={t("images.bulk_delete.title")} disabled={acting || selectedDeletableCount === 0} onClick={runBulkDelete} />
                <Button title={t("images.bulk_compress.title")} disabled={acting || selectedCompressibleCount === 0} onClick={runBulkCompress} />
              </div>
            </div>
          ) : null}
        </div>
      </SettingsCard>

      {!loading && items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold t-primary">{t("images.results.title$count", { count: items.length })}</p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {hasActiveFilters ? t("images.results.filtered") : t("images.results.all")}
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <input
              type="checkbox"
              checked={items.length > 0 && selectedIds.length === items.length}
              onChange={(event) => setSelectedIds(event.target.checked ? items.map((asset) => asset.id) : [])}
            />
            {t("images.selection.all")}
          </label>
        </div>
      ) : null}

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
            <div key={asset.id} className="grid grid-cols-[auto_3rem_minmax(13rem,1fr)_minmax(0,1.5fr)_auto] items-center gap-3 border-b border-black/5 px-3 py-2 last:border-b-0 dark:border-white/5">
              <input type="checkbox" checked={selectedIds.includes(asset.id)} onChange={() => toggleSelected(asset.id)} />
              <button type="button" onClick={() => openDetails(asset)} title={t("images.details.open")}>
                <ImagePreview asset={asset} compact />
              </button>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden [&>span]:shrink-0 [&>span]:whitespace-nowrap">
                <SettingsBadge tone={asset.favorite === 1 ? "warning" : "neutral"}>{asset.favorite === 1 ? t("images.favorite.yes") : t("images.favorite.no")}</SettingsBadge>
                <SettingsBadge tone={asset.source === "external" ? "neutral" : "success"}>{t(`images.source.${asset.source}`)}</SettingsBadge>
                <SettingsBadge tone={getCompressionTone(asset.compressionStatus)}>{t(`images.compression.${asset.compressionStatus}`)}</SettingsBadge>
              </div>
              <div className="min-w-0 overflow-hidden">
                {renderCompactMeta(asset)}
              </div>
              <div className="flex items-center justify-end gap-2">
                <CompactAction
                  icon={asset.favorite === 1 ? "ri-star-fill" : "ri-star-line"}
                  title={asset.favorite === 1 ? t("images.favorite.remove") : t("images.favorite.add")}
                  onClick={() => toggleFavorite(asset)}
                />
                <CompactAction
                  icon="ri-file-copy-line"
                  title={t("images.copy.title")}
                  onClick={() => copyLink(asset)}
                />
                <CompactAction
                  icon="ri-information-line"
                  title={t("images.details.open")}
                  onClick={() => openDetails(asset)}
                />
                <CompactAction
                  icon="ri-file-zip-line"
                  title={t("images.compress_one")}
                  disabled={acting || !canCompress(asset)}
                  onClick={() => compressOne(asset)}
                />
                <CompactAction
                  icon="ri-delete-bin-line"
                  title={t("delete.title")}
                  disabled={!canDelete(asset)}
                  onClick={() => deleteOne(asset)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && viewMode === "grid" && items.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
          {items.map((asset) => (
            <div key={asset.id} className="overflow-hidden rounded-xl border border-neutral-200/80 bg-w dark:border-neutral-800/80">
              <div className="relative aspect-[4/3] bg-neutral-100 dark:bg-white/5">
                <button type="button" className="block h-full w-full" onClick={() => openDetails(asset)} title={t("images.details.open")}>
                  <img
                    src={asset.url}
                    alt=""
                    className="h-full w-full object-cover transition-transform hover:scale-[1.02]"
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                </button>
                <div className="absolute left-3 top-3 rounded-full bg-white/90 p-1 shadow-sm dark:bg-neutral-950/80">
                  <input type="checkbox" checked={selectedIds.includes(asset.id)} onChange={() => toggleSelected(asset.id)} />
                </div>
                <div className="absolute right-3 top-3 flex max-w-[calc(100%-4rem)] flex-wrap justify-end gap-2 [&>span]:shadow-sm [&>span]:whitespace-nowrap">
                  {asset.favorite === 1 ? <SettingsBadge tone="warning">{t("images.favorite.yes")}</SettingsBadge> : null}
                  <SettingsBadge tone={asset.source === "external" ? "neutral" : "success"}>{t(`images.source.${asset.source}`)}</SettingsBadge>
                  <SettingsBadge tone={getCompressionTone(asset.compressionStatus)}>{t(`images.compression.${asset.compressionStatus}`)}</SettingsBadge>
                </div>
              </div>
              <div className="p-3">
                <div className="min-w-0 overflow-hidden">{renderCompactMeta(asset)}</div>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <CompactAction
                    icon={asset.favorite === 1 ? "ri-star-fill" : "ri-star-line"}
                    title={asset.favorite === 1 ? t("images.favorite.remove") : t("images.favorite.add")}
                    onClick={() => toggleFavorite(asset)}
                  />
                  <CompactAction
                    icon="ri-file-copy-line"
                    title={t("images.copy.title")}
                    onClick={() => copyLink(asset)}
                  />
                  <CompactAction
                    icon="ri-information-line"
                    title={t("images.details.open")}
                    onClick={() => openDetails(asset)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
