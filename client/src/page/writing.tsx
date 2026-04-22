import i18n from 'i18next';
import _ from 'lodash';
import {useCallback, useEffect, useState} from "react";
import {Helmet} from "react-helmet";
import {useTranslation} from "react-i18next";
import Loading from 'react-loading';
import {ShowAlertType, useAlert, useConfirm} from '../components/dialog';
import {Checkbox, Input} from "../components/input";
import { DateTimeInput, FlatMetaRow, FlatPanel } from "@rin/ui";
import { client } from "../app/runtime";
import {Cache} from '../utils/cache';
import {useSiteConfig} from "../hooks/useSiteConfig";
import {siteName} from "../utils/constants";
import mermaid from 'mermaid';
import { MarkdownEditor } from '../components/markdown_editor';

type DiffLineType = "context" | "add" | "del";

type DiffLine = {
  type: DiffLineType;
  oldNo?: number;
  newNo?: number;
  text: string;
};

function buildDiffLines(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: "context", oldNo, newNo, text: oldLines[i] });
      i++;
      j++;
      oldNo++;
      newNo++;
    } else {
      if (i < oldLines.length) {
        result.push({ type: "del", oldNo, text: oldLines[i] });
        i++;
        oldNo++;
      }
      if (j < newLines.length) {
        result.push({ type: "add", newNo, text: newLines[j] });
        j++;
        newNo++;
      }
    }
  }

  return result;
}

function collapseContextLines(lines: DiffLine[], contextRadius = 3): DiffLine[] {
  const important = lines.map(
    (l) => l.type === "add" || l.type === "del",
  );
  if (!important.some(Boolean)) return lines;

  const keep = new Array(lines.length).fill(false);
  for (let idx = 0; idx < lines.length; idx++) {
    if (!important[idx]) continue;
    const start = Math.max(0, idx - contextRadius);
    const end = Math.min(lines.length - 1, idx + contextRadius);
    for (let k = start; k <= end; k++) keep[k] = true;
  }

  const collapsed: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i] || lines[i].type !== "context") {
      collapsed.push(lines[i]);
      i++;
    } else {
      let j = i;
      while (
        j < lines.length &&
        !keep[j] &&
        lines[j].type === "context"
      ) {
        j++;
      }
      collapsed.push({
        type: "context",
        text: "…",
      });
      i = j;
    }
  }

  return collapsed;
}

function ContentDiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const lines = collapseContextLines(buildDiffLines(oldContent, newContent));

  return (
    <div className="mt-2 max-h-96 overflow-auto border rounded bg-gray-50">
      <div className="px-2 py-1 text-xs font-mono text-gray-500 border-b">
        @@ -1,{oldContent.split(/\r?\n/).length} +1,{newContent.split(/\r?\n/).length} @@
      </div>
      <table className="w-full text-xs font-mono">
        <tbody>
          {lines.map((line, idx) => {
            const bg =
              line.type === "add"
                ? "bg-green-50"
                : line.type === "del"
                  ? "bg-red-50"
                  : "bg-transparent";
            const marker =
              line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
            return (
              <tr key={idx} className={bg}>
                <td className="w-10 px-2 text-right text-gray-400 align-top">
                  {line.oldNo ?? ""}
                </td>
                <td className="w-10 px-2 text-right text-gray-400 align-top border-l border-gray-200">
                  {line.newNo ?? ""}
                </td>
                <td className="w-4 px-2 align-top text-gray-500">{marker}</td>
                <td className="px-2 py-0.5 align-top whitespace-pre">
                  {line.text === "" ? "\u00a0" : line.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function publish({
  title,
  alias,
  listed,
  content,
  summary,
  tags,
  draft,
  createdAt,
  onCompleted,
  showAlert
}: {
  title: string;
  listed: boolean;
  content: string;
  summary: string;
  tags: string[];
  draft: boolean;
  alias?: string;
  createdAt?: Date;
  onCompleted?: () => void;
  showAlert: ShowAlertType;
}) {
  const t = i18n.t
  const { data, error } = await client.feed.create(
    {
      title,
      alias,
      content,
      summary,
      tags,
      listed,
      draft,
      createdAt: createdAt?.toISOString(),
    }
  );
  if (onCompleted) {
    onCompleted();
  }
  if (error) {
    showAlert(error.value as string);
  }
  if (data) {
    showAlert(t("publish.success"), () => {
      Cache.with().clear();
      window.location.href = "/feed/" + data.insertedId;
    });
  }
}

async function update({
  id,
  title,
  alias,
  content,
  summary,
  tags,
  listed,
  draft,
  createdAt,
  onCompleted,
  showAlert
}: {
  id: number;
  listed: boolean;
  title?: string;
  alias?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  draft?: boolean;
  createdAt?: Date;
  onCompleted?: () => void;
  showAlert: ShowAlertType;
}) {
  const t = i18n.t
  const { error } = await client.feed.update(
    id,
    {
      title,
      alias,
      content,
      summary,
      tags,
      listed,
      draft,
      createdAt: createdAt?.toISOString(),
    }
  );
  if (onCompleted) {
    onCompleted();
  }
  if (error) {
    showAlert(error.value as string);
  } else {
    showAlert(t("update.success"), () => {
      Cache.with(id).clear();
      window.location.href = "/feed/" + id;
    });
  }
}

// 写作页面
export function WritingPage({ id }: { id?: number }) {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const cache = Cache.with(id);
  const [title, setTitle] = cache.useCache("title", "");
  const [summary, setSummary] = cache.useCache("summary", "");
  const [tags, setTags] = cache.useCache("tags", "");
  const [alias, setAlias] = cache.useCache("alias", "");
  const [draft, setDraft] = useState(false);
  const [listed, setListed] = useState(true);
  const [content, setContent] = cache.useCache("content", "");
  const [createdAt, setCreatedAt] = useState<Date | undefined>(new Date());
  const [publishing, setPublishing] = useState(false)
  const { showAlert, AlertUI } = useAlert()
  const { showConfirm, ConfirmUI } = useConfirm()
  function publishButton() {
    if (publishing) return;
    const tagsplit =
      tags
        .split("#")
        .filter((tag) => tag !== "")
        .map((tag) => tag.trim()) || [];
    if (id !== undefined) {
      setPublishing(true)
      update({
        id,
        title,
        content,
        summary,
        alias,
        tags: tagsplit,
        draft,
        listed,
        createdAt,
        onCompleted: () => {
          setPublishing(false)
        },
        showAlert
      });
    } else {
      if (!title) {
        showAlert(t("title_empty"))
        return;
      }
      if (!content) {
        showAlert(t("content.empty"))
        return;
      }
      setPublishing(true)
      publish({
        title,
        content,
        summary,
        tags: tagsplit,
        draft,
        alias,
        listed,
        createdAt,
        onCompleted: () => {
          setPublishing(false)
        },
        showAlert
      });
    }
  }

  useEffect(() => {
    if (id) {
      client.feed
        .get(id)
        .then(({ data }) => {
          if (data) {
            const remoteTitle = data.title ?? "";
            const remoteTags = data.hashtags
              ? data.hashtags.map(({ name }) => `#${name}`).join(" ")
              : "";
            const remoteAlias = data.alias ?? "";
            const remoteContent = data.content ?? "";
            const remoteSummary = data.summary ?? "";
            const hasLocalCache =
              title !== "" ||
              tags !== "" ||
              alias !== "" ||
              content !== "" ||
              summary !== "";

            const hasDiff =
              remoteTitle !== title ||
              remoteTags !== tags ||
              remoteAlias !== alias ||
              remoteContent !== content ||
              remoteSummary !== summary;

            const applyRemoteData = () => {
              setTitle(remoteTitle);
              setTags(remoteTags);
              setAlias(remoteAlias);
              setContent(remoteContent);
              setSummary(remoteSummary);
              setListed(data.listed === 1);
              setDraft(data.draft === 1);
              setCreatedAt(new Date(data.createdAt));
            };

            if (!hasLocalCache) {
              applyRemoteData();
              return;
            }

            if (!hasDiff) {
              applyRemoteData();
              return;
            }

            const diffLines: string[] = [];

            if (remoteTitle !== title) {
              diffLines.push(`[${t("title")}]`);
              diffLines.push(`- ${t("local")}: ${title || t("empty")}`);
              diffLines.push(`+ ${t("remote")}: ${remoteTitle || t("empty")}`);
              diffLines.push("");
            }

            if (remoteTags !== tags) {
              diffLines.push(`[${t("tags")}]`);
              diffLines.push(`- ${t("local")}: ${tags || t("empty")}`);
              diffLines.push(`+ ${t("remote")}: ${remoteTags || t("empty")}`);
              diffLines.push("");
            }

            if (remoteAlias !== alias) {
              diffLines.push(`[${t("alias")}]`);
              diffLines.push(`- ${t("local")}: ${alias || t("empty")}`);
              diffLines.push(`+ ${t("remote")}: ${remoteAlias || t("empty")}`);
              diffLines.push("");
            }

            if (remoteSummary !== summary) {
              diffLines.push(`[${t("summary")}]`);
              diffLines.push(`- ${t("local")}: ${summary || t("empty")}`);
              diffLines.push(`+ ${t("remote")}: ${remoteSummary || t("empty")}`);
              diffLines.push("");
            }

            const metaMessage = diffLines.join("\n");

            const messageNode = (
              <div className="space-y-3">
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t("writing.remote_diff_default_message")}
                </p>
                {metaMessage && (
                  <pre className="whitespace-pre-wrap font-mono text-xs bg-gray-50 p-2 rounded border">
                    {metaMessage}
                  </pre>
                )}
                {remoteContent !== content && (
                  <div>
                    <div className="text-sm font-semibold mb-1">
                      {t("content")}
                    </div>
                    <ContentDiffView
                      oldContent={content || ""}
                      newContent={remoteContent || ""}
                    />
                  </div>
                )}
              </div>
            );

            showConfirm(
              t("writing.remote_diff_title"),
              messageNode,
              applyRemoteData
            );
          }
        });
    }
  }, []);
  const debouncedUpdate = useCallback(
    _.debounce(() => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
      });
      mermaid.run({
        suppressErrors: true,
        nodes: document.querySelectorAll("pre.mermaid_default")
      }).then(()=>{
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
        });
        mermaid.run({
          suppressErrors: true,
          nodes: document.querySelectorAll("pre.mermaid_dark")
        });
      })
    }, 100),
    []
  );
  useEffect(() => {
    debouncedUpdate();
  }, [content, debouncedUpdate]);
  function PublishButton({ className }: { className?: string }) {
    return (
      <button
        onClick={publishButton}
        className={`inline-flex items-center justify-center gap-2 rounded-xl bg-theme px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-theme-hover active:bg-theme-active disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ""}`}
        disabled={publishing}
      >
        {publishing && <Loading type="spin" height={16} width={16} />}
        <span>{t('publish.title')}</span>
      </button>
    );
  }

  function MetaInput({ className }: { className?: string }) {
    return (
        <FlatPanel className={className}>
          <div className="flex flex-row gap-4 border-b border-black/5 pb-5 dark:border-white/5 items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme/70">{t('writing')}</p>
              <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                {id !== undefined ? t("update.title") : t("publish.title")}
              </p>
            </div>
            <PublishButton className="w-auto" />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <Input
                id={id}
                value={title}
                setValue={setTitle}
                placeholder={t("title")}
                variant="flat"
                className="text-base"
              />
            </div>
            <Input
              id={id}
              value={summary}
              setValue={setSummary}
              placeholder={t("summary")}
              variant="flat"
            />
            <Input
              id={id}
              value={alias}
              setValue={setAlias}
              placeholder={t("alias")}
              variant="flat"
            />
            <Input
              id={id}
              value={tags}
              setValue={setTags}
              placeholder={t("tags")}
              variant="flat"
              className="lg:col-span-2"
            />
          </div>

          <div className="mt-5 grid gap-2 sm:gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,2fr)]">
            <FlatMetaRow
              className="cursor-pointer rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3"
              onClick={() => setDraft(!draft)}
            >
              <p>{t('visible.self_only')}</p>
              <Checkbox
                id="draft"
                value={draft}
                setValue={setDraft}
                placeholder={t('draft')}
              />
            </FlatMetaRow>
            <FlatMetaRow
              className="cursor-pointer rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3"
              onClick={() => setListed(!listed)}
            >
              <p>{t('listed')}</p>
              <Checkbox
                id="listed"
                value={listed}
                setValue={setListed}
                placeholder={t('listed')}
              />
            </FlatMetaRow>
            <FlatMetaRow className="gap-3 rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3 xl:col-span-1">
              <p className="mr-2 whitespace-nowrap">
                {t('created_at')}
              </p>
              <DateTimeInput value={createdAt} onChange={setCreatedAt} className="w-full max-w-[16rem]" />
            </FlatMetaRow>
          </div>
        </FlatPanel>
    )
  }

  return (
    <>
      <Helmet>
        <title>{`${t('writing')} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t('writing')} />
        <meta property="og:image" content={siteConfig.avatar} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <div className="mt-2 flex flex-col gap-4 t-primary sm:gap-6">
        {MetaInput({ className: "p-4 sm:p-5 md:p-6" })}

        <FlatPanel className="overflow-hidden p-0">
          <MarkdownEditor content={content} setContent={setContent} height='680px' />
        </FlatPanel>
      </div>
      <AlertUI />
      <ConfirmUI />
    </>
  );
}
