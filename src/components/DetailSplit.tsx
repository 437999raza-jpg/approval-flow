"use client";

import { useState, type ReactNode } from "react";

interface DetailSplitProps {
  fileName: string;
  fileUrl: string | null;
  isPdf: boolean;
  isImage: boolean;
  children: ReactNode; // side panel content (server-rendered)
}

// Dext/ApprovalMax-style split: the invoice document on the left, the side
// panel on the right. The document pane collapses to a slim strip and the
// panel then takes the full width. Client component with explicit state so
// the collapse is guaranteed to work. Authored by Araza.
export function DetailSplit({
  fileName,
  fileUrl,
  isPdf,
  isImage,
  children,
}: DetailSplitProps) {
  const [showDoc, setShowDoc] = useState(true);

  return (
    <div className="flex min-w-0 flex-1">
      {showDoc ? (
        <div className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-slate-100">
          <div className="flex flex-none items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setShowDoc(false)}
                title="Hide document"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    d="M15 6l-6 6 6 6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <span className="truncate text-sm font-medium text-slate-700">
                {fileName}
              </span>
            </span>
            {fileUrl && (
              <a
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-none text-xs font-medium text-blue-600 hover:underline"
              >
                Open in new tab ↗
              </a>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {fileUrl ? (
              isImage ? (
                // Deliberately a plain <img>: the source is an expiring
                // signed URL for a user-uploaded document, not something
                // next/image can optimize.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={fileUrl}
                  alt={fileName}
                  className="mx-auto max-w-full rounded-md shadow"
                />
              ) : isPdf ? (
                <object data={fileUrl} type="application/pdf" className="h-full w-full">
                  <p className="text-sm text-slate-500">
                    Your browser can&apos;t display this PDF.{" "}
                    <a
                      href={fileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline"
                    >
                      Open it instead
                    </a>
                    .
                  </p>
                </object>
              ) : (
                <p className="text-sm text-slate-500">
                  No preview for this file type.{" "}
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 underline"
                  >
                    Open file
                  </a>
                  .
                </p>
              )
            ) : (
              <p className="text-sm text-slate-500">File preview unavailable.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-none flex-col items-center gap-3 border-r border-slate-200 bg-slate-100 py-3">
          <button
            type="button"
            onClick={() => setShowDoc(true)}
            title="Show document"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                d="M9 6l6 6-6 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-[11px] font-medium text-slate-400 [writing-mode:vertical-rl]">
            Document
          </span>
        </div>
      )}

      <div
        className={
          showDoc
            ? "w-[400px] flex-none overflow-y-auto bg-white"
            : "min-w-0 flex-1 overflow-y-auto bg-white"
        }
      >
        {children}
      </div>
    </div>
  );
}
