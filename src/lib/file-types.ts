// File-type helpers for previewing documents (allowed types are pdf, png,
// jpeg, webp — see src/lib/invoices.ts). Authored by Araza.

export const extOf = (name: string) =>
  name.split(".").pop()?.toLowerCase() ?? "";

export const isPdfName = (name: string) => extOf(name) === "pdf";

export const isImageName = (name: string) =>
  ["png", "jpg", "jpeg", "webp"].includes(extOf(name));
