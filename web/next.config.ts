import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Constrain static-generation workers: worker counts derived from host CPU
  // count exceed sandboxed build memory limits (2 GB cgroup) and get the
  // build killed during page-data collection. A low fixed cap keeps builds
  // reproducible on any machine without changing app behavior.
  experimental: {
    cpus: 1,
  },
};

export default nextConfig;
