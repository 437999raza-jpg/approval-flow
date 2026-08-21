"use client";

import { useRef, useState } from "react";

export function AvatarUploadForm({
  uploadAction,
}: {
  uploadAction: (formData: FormData) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [uploading, setUploading] = useState(false);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        setUploading(true);
        await uploadAction(formData);
        setUploading(false);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        name="photo"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={() => formRef.current?.requestSubmit()}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="text-sm text-blue-600 hover:underline disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "Upload photo"}
      </button>
    </form>
  );
}
