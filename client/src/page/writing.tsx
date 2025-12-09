import i18n from 'i18next';
import _ from 'lodash';
import {Calendar} from 'primereact/calendar';
import 'primereact/resources/primereact.css';
import 'primereact/resources/themes/lara-light-indigo/theme.css';
import {useCallback, useEffect, useState} from "react";
import {Helmet} from "react-helmet";
import {useTranslation} from "react-i18next";
import Loading from 'react-loading';
import {ShowAlertType, useAlert, useConfirm} from '../components/dialog';
import {Checkbox, Input} from "../components/input";
import {client} from "../main";
import {headersWithAuth} from "../utils/auth";
import {Cache} from '../utils/cache';
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

function ContentDiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const lines = buildDiffLines(oldContent, newContent);

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
  const { data, error } = await client.feed.index.post(
    {
      title,
      alias,
      content,
      summary,
      tags,
      listed,
      draft,
      createdAt,
    },
    {
      headers: headersWithAuth(),
    }
  );
  if (onCompleted) {
    onCompleted();
  }
  if (error) {
    showAlert(error.value as string);
  }
  if (data && typeof data !== "string") {
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
  const { error } = await client.feed({ id }).post(
    {
      title,
      alias,
      content,
      summary,
      tags,
      listed,
      draft,
      createdAt,
    },
    {
      headers: headersWithAuth(),
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
      client
        .feed({ id })
        .get({
          headers: headersWithAuth(),
        })
        .then(({ data }) => {
          if (data && typeof data !== "string") {
            const remoteTitle = data.title ?? "";
            const remoteTags = data.hashtags
              ? data.hashtags.map(({ name }) => `#${name}`).join(" ")
              : "";
            const remoteAlias = data.alias ?? "";
            const remoteContent = data.content ?? "";
            const remoteSummary = data.summary ?? "";

            const hasDiff =
              remoteTitle !== title ||
              remoteTags !== tags ||
              remoteAlias !== alias ||
              remoteContent !== content ||
              remoteSummary !== summary;

            if (!hasDiff) {
              setListed(data.listed === 1);
              setDraft(data.draft === 1);
              setCreatedAt(new Date(data.createdAt));
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
              () => {
                if (remoteTitle) setTitle(remoteTitle);
                if (remoteTags) setTags(remoteTags);
                if (remoteAlias) setAlias(remoteAlias);
                setContent(remoteContent);
                setSummary(remoteSummary);
                setListed(data.listed === 1);
                setDraft(data.draft === 1);
                setCreatedAt(new Date(data.createdAt));
              }
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
  function MetaInput({ className }: { className?: string }) {
    return (
      <>
        <div className={className}>
          <Input
            id={id}
            value={title}
            setValue={setTitle}
            placeholder={t("title")}
          />
          <Input
            id={id}
            value={summary}
            setValue={setSummary}
            placeholder={t("summary")}
            className="mt-4"
          />
          <Input
            id={id}
            value={tags}
            setValue={setTags}
            placeholder={t("tags")}
            className="mt-4"
          />
          <Input
            id={id}
            value={alias}
            setValue={setAlias}
            placeholder={t("alias")}
            className="mt-4"
          />
          <div
            className="select-none flex flex-row justify-between items-center mt-6 mb-2 px-4"
            onClick={() => setDraft(!draft)}
          >
            <p>{t('visible.self_only')}</p>
            <Checkbox
              id="draft"
              value={draft}
              setValue={setDraft}
              placeholder={t('draft')}
            />
          </div>
          <div
            className="select-none flex flex-row justify-between items-center mt-6 mb-2 px-4"
            onClick={() => setListed(!listed)}
          >
            <p>{t('listed')}</p>
            <Checkbox
              id="listed"
              value={listed}
              setValue={setListed}
              placeholder={t('listed')}
            />
          </div>
          <div className="select-none flex flex-row justify-between items-center mt-4 mb-2 pl-4">
            <p className="break-keep mr-2">
              {t('created_at')}
            </p>
            <Calendar value={createdAt} onChange={(e) => setCreatedAt(e.value || undefined)} showTime touchUI hourFormat="24" />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Helmet>
        <title>{`${t('writing')} - ${process.env.NAME}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t('writing')} />
        <meta property="og:image" content={process.env.AVATAR} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <div className="grid grid-cols-1 md:grid-cols-3 t-primary mt-2">
        <div className="col-span-2 pb-8">
          <div className="bg-w rounded-2xl shadow-xl shadow-light p-4">
            {MetaInput({ className: "visible md:hidden mb-8" })}
            <MarkdownEditor content={content} setContent={setContent} height='600px' />
          </div>
          <div className="visible md:hidden flex flex-row justify-center mt-8">
            <button
              onClick={publishButton}
              className="basis-1/2 bg-theme text-white py-4 rounded-full shadow-xl shadow-light flex flex-row justify-center items-center space-x-2"
            >
              {publishing &&
                <Loading type="spin" height={16} width={16} />
              }
              <span>
                {t('publish.title')}
              </span>
            </button>
          </div>
        </div>
        <div className="hidden md:visible max-w-96 md:flex flex-col">
          {MetaInput({ className: "bg-w rounded-2xl shadow-xl shadow-light p-4 mx-8" })}
          <div className="flex flex-row justify-center mt-8">
            <button
              onClick={publishButton}
              className="basis-1/2 bg-theme text-white py-4 rounded-full shadow-xl shadow-light flex flex-row justify-center items-center space-x-2"
            >
              {publishing &&
                <Loading type="spin" height={16} width={16} />
              }
              <span>
                {t('publish.title')}
              </span>
            </button>
          </div>
        </div>
      </div>
      <AlertUI />
      <ConfirmUI />
    </>

  );
}
