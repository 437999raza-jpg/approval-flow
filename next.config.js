/** @type {import('next').NextConfig} */
const nextConfig = {
  // mupdf is a WASM package; load it natively in server contexts instead of
  // letting webpack try to bundle the .wasm binary (which breaks it).
  experimental: {
    serverComponentsExternalPackages: ["mupdf"],
  },
};

module.exports = nextConfig;
