/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the build strict; we rely on `tsc`/`next build` catching type errors.
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
