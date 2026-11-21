// Next.js settings for the sky map.
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The page and the /api/stars route both read the catalog; neither needs a polyfill.
  experimental: { typedRoutes: true },
};

export default nextConfig;
